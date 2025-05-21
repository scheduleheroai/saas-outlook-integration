// supabase/functions/calendly-calendar-webhook/index.ts
// Version: 2025-05-12_01 — Initial draft, patterned after google‑calendar‑webhook but for Calendly
// -----------------------------------------------------------------------------
// Primary job
//  → Handle POST webhooks from Calendly (invitee.created / invitee.canceled)
//  → Pull richer details via Calendly REST API using our stored OAuth token
//  → Decide if an automated phone‑call task is needed (confirmation, cancellation
//    recovery, etc.) based on the owner’s settings
//  → Upsert a row in `outbound_call_queue`
//
// Caveats / TODOs
//  • If you enable the optional signing key in Calendly you **must** verify
//    `X‑Calendly‑Webhook‑Signature` (HMAC‑SHA256).
//  • Add logic for no‑shows or reschedules if you can infer them (Calendly sends
//    reschedule events as a separate `invitee.canceled` + `invitee.created`).
// -----------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7?target=deno";
import { parseISO, isValid, isPast } from "https://esm.sh/date-fns@3.6.0?target=deno";
import { decode as b64decode, encode as b64encode } from "https://deno.land/std@0.208.0/encoding/base64.ts";
import { getValidCredentials } from "../_shared/calendar-helpers.ts";

// -----------------------------------------------------------------------------
// Shared helpers (cors, (de)crypt)
// -----------------------------------------------------------------------------
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-calendly-webhook-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function verifySignature(secret: string, body: Uint8Array, sigHeader: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, body);
  const computedSig = "sha256=" + Array.from(new Uint8Array(signature)).map(b =>
    b.toString(16).padStart(2, "0")
  ).join("");
  return computedSig === sigHeader;
}

async function deriveKey(k: string): Promise<CryptoKey> {
  const hashed = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(k));
  return crypto.subtle.importKey("raw", hashed, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function encrypt(txt: string, k: string): Promise<string> {
  const key = await deriveKey(k);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(txt));
  return JSON.stringify({ iv: b64encode(iv), data: b64encode(new Uint8Array(cipher)) });
}
async function decrypt(enc: string, k: string): Promise<string> {
  const { iv, data } = JSON.parse(enc);
  const key = await deriveKey(k);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(iv) }, key, b64decode(data));
  return new TextDecoder().decode(plain);
}

// -----------------------------------------------------------------------------
// Typings for Calendly webhook
// -----------------------------------------------------------------------------
interface CalendlyScheduledEvent {
  uri: string;
  name?: string;
  start_time: string;
  end_time: string;
  status: string;
  event_memberships?: { user_email: string }[]; // Added event_memberships property
}

interface CalendlyInviteePayload {
  uri: string;
  name: string;
  email: string;
  text_reminder_number?: string;
}

interface CalendlyWebhookBody {
  event: "invitee.created" | "invitee.canceled";
  payload: {
    event: string;
    invitee: CalendlyInviteePayload;
    scheduled_event?: CalendlyScheduledEvent;
    cancel_reason?: string;
  };
}

type CallType = "confirm_appointment" | "recover_cancellation" | "reschedule_noshow";

// Simple helpers --------------------------------------------------------------
function parsePhone(raw?: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/^(?:\+?1)?[\s\-.]?(\d{3})[\s\-.]?(\d{3})[\s\-.]?(\d{4})$/);
  return m ? `+1${m[1]}${m[2]}${m[3]}` : null;
}

// Supabase --------------------------------------------------------------------
function sbAdmin() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase env vars missing");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// -----------------------------------------------------------------------------
// Main handler
// -----------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  // Verify signature (optional but recommended) ------------------------------
  const signingKey = Deno.env.get("CALENDLY_WEBHOOK_SIGNING_KEY");
  const sigHeader = req.headers.get("X-Calendly-Webhook-Signature");
  const rawBody = new Uint8Array(await req.arrayBuffer());
  if (signingKey && sigHeader) {
    const valid = await verifySignature(signingKey, rawBody, sigHeader);
    if (!valid) {
      console.warn("[CalendlyWebhook] Signature mismatch — reject");
      return new Response("Forbidden", { status: 403, headers: corsHeaders });
    }
  }

  // Parse JSON body ----------------------------------------------------------
  let body: CalendlyWebhookBody;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
  } catch (_) {
    return new Response("Bad JSON", { status: 400, headers: corsHeaders });
  }

  // ACK immediately; heavy work async ----------------------------------------
  const ack = new Response("OK", { status: 200, headers: corsHeaders });

  (async () => {
    const supabase = sbAdmin();
    const encryptionKey = Deno.env.get("CALENDAR_CREDENTIALS_ENCRYPTION_KEY");
    if (!encryptionKey) throw new Error("Missing CALENDAR_CREDENTIALS_ENCRYPTION_KEY");

    // 1. Locate integration (provider = calendly, status active) -------------
    const calendlyUserEmail = body.payload.scheduled_event?.event_memberships?.[0]?.user_email;
    const { data: integration, error: intErr } = await supabase
      .from("calendar_integrations")
      .select("id, user_id, encrypted_credentials, provider")
      .eq("provider", "calendly")
      .eq("status", "active_watching")
      .eq("account_email", calendlyUserEmail)
      .single();

    if (intErr) {
      console.error("[CalendlyWebhook] DB error", intErr);
      return;
    }
    if (!integration) {
      console.warn("[CalendlyWebhook] No active Calendly integration — skipping");
      return;
    }

    // 2. Decrypt OAuth token --------------------------------------------------
    const tokens = await getValidCredentials(integration);
    if (!tokens?.access_token) {
      console.error("[CalendlyWebhook] No valid access token — aborting");
      return;
    }

    // 3. Fetch scheduled event details ---------------------------------------
    const schedEvtUri = body.payload.scheduled_event?.uri || body.payload.event; // e.g. https://api.calendly.com/scheduled_events/UUID
    
    if (!schedEvtUri) {
      console.error("[CalendlyWebhook] Missing scheduled_event.uri and event. Raw payload:", JSON.stringify(body, null, 2));
      return;
    }

    console.log(`[CalendlyWebhook] Fetching event ${schedEvtUri}`);
    const evtRes = await fetch(schedEvtUri, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!evtRes.ok) {
      console.error(`[CalendlyWebhook] Failed to get event ${schedEvtUri}: ${evtRes.status}`);
      return;
    }
    const eventJson = await evtRes.json();
    const scheduledEvent = eventJson.resource; // Calendly wraps result under resource
    console.log(`[CalendlyWebhook] Event details: ${JSON.stringify(eventJson, null, 2)}`);
    // 4. Basic invitee info is already in the webhook -------------------------
    const invitee = body.payload?.invitee;
    const name = invitee?.name || scheduledEvent.name || "Customer";
    const phone = parsePhone(invitee?.text_reminder_number || scheduledEvent?.location?.location || "");

    if (!phone) {
      console.log(`[CalendlyWebhook] Skip — no phone for invitee ${invitee.uri}`);
      return;
    }

    const startIso = scheduledEvent.start_time; // ISO UTC
    const endIso = scheduledEvent.end_time;

    // 5. Fetch user call settings --------------------------------------------
    const { data: settingsRow, error: setErr } = await supabase
      .from("user_settings")
      .select("call_activation_settings")
      .eq("user_id", integration.user_id)
      .maybeSingle();
    if (setErr) {
      console.error("[CalendlyWebhook] settings fetch error", setErr);
      return;
    }
    const settings = settingsRow?.call_activation_settings || {};

    // 6. Determine call type --------------------------------------------------
    let callType: CallType | null = null;
    console.log(`[CalendlyWebhook] Received ${body.event} for event ${scheduledEvent.uri}`);
    if (body.event === "invitee.created") {
      const maybeOldInvitee = (body.payload as any)?.old_invitee;
    
      if (maybeOldInvitee) {
        console.log(`[CalendlyWebhook] Invitee.created is a reschedule — updating old invitee (${maybeOldInvitee})`);
    
        const parts = scheduledEvent.uri.split("/");
        const new_event_id = parts[parts.length - 1];
    
        const updateFields = {
          calendar_event_id: new_event_id,
          event_start_time: scheduledEvent.start_time,
          event_end_time: scheduledEvent.end_time,
          updated_at: new Date().toISOString(),
        };
    
        const { error: updateErr } = await supabase
          .from("outbound_call_queue")
          .update(updateFields)
          .eq("customer_phone", phone);
    
        if (updateErr) {
          console.error("[CalendlyWebhook] Failed to update rescheduled invitee", updateErr);
        } else {
          console.log(`[CalendlyWebhook] Updated invitee based on reschedule (phone: ${phone})`);
        }
    
        return; // Do not queue a confirmation call
      }
    
      // Regular confirmation for new bookings
      if (settings.confirm_appointments?.enabled) {
        const ts = parseISO(startIso);
        if (!isValid(ts) || isPast(ts)) {
          console.log(`[CalendlyWebhook] Created event already past — no confirmation call`);
        } else {
          callType = "confirm_appointment";
        }
      }
    }
    
    if (body.event === "invitee.canceled") {
      const rescheduled = (body.payload as any)?.rescheduled === true;
    
      if (rescheduled) {
        console.log(`[CalendlyWebhook] Skipping canceled event — part of a reschedule`);
        return; // Do nothing
      }
    
      if (settings.recover_cancellations?.enabled) {
        callType = "recover_cancellation";
      }
    }
    
    if (!callType) {
      console.log(`[CalendlyWebhook] Event ${body.event} did not trigger a call`);
      return;
    }

    // 7. Upsert outbound call task -------------------------------------------
    const parts = scheduledEvent.uri.split("/");
    const event_id = parts[parts.length - 1];
    const rec = {
      user_id: integration.user_id,
      calendar_integration_id: integration.id,
      calendar_event_id: event_id,
      event_start_time: startIso,
      event_end_time: endIso,
      event_summary: scheduledEvent.name || null,
      customer_name: name,
      customer_phone: phone,
      call_type: callType,
      status: "pending",
      updated_at: new Date().toISOString(),
    };

    const { error: upsertErr } = await supabase
      .from("outbound_call_queue")
      .upsert(rec, { onConflict: "calendar_event_id" });

    if (upsertErr) {
      console.error("[CalendlyWebhook] Queue upsert failed", upsertErr);
    } else {
      console.log(`[CalendlyWebhook] Queued ${callType} for event ${scheduledEvent.uri}`);
    }
  })().catch((e) => console.error("[CalendlyWebhook] Uncaught async error", e));

  return ack;
});

console.log("[INFO] Calendly Webhook Edge Function initialised.");
