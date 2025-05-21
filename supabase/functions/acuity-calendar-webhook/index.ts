// supabase/functions/acuity-calendar-webhook/index.ts
// Version: 2025-05-15 — Production-ready Acuity Webhook Handler

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7?target=deno";
import { parseISO, isValid, isPast } from "https://esm.sh/date-fns@3.6.0?target=deno";
import { decode as b64decode } from "https://deno.land/std@0.208.0/encoding/base64.ts";
import { getValidCredentials } from "../_shared/calendar-helpers.ts";

// --- CORS Headers ---
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-acuity-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// --- Encryption Helpers ---
async function deriveKey(keyString: string): Promise<CryptoKey> {
  const keyMaterial = new TextEncoder().encode(keyString);
  const hash = await crypto.subtle.digest("SHA-256", keyMaterial);
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function decrypt(encryptedStr: string, keyString: string): Promise<string> {
  const { iv, data } = JSON.parse(encryptedStr);
  const key = await deriveKey(keyString);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(iv) }, key, b64decode(data));
  return new TextDecoder().decode(decrypted);
}

// --- Utilities ---
function parsePhone(raw?: string | null): string | null {
  if (!raw) return null;
  const match = raw.match(/^(?:\+?1)?\D*([2-9]\d{2})\D*([2-9]\d{2})\D*(\d{4})$/);
  return match ? `+1${match[1]}${match[2]}${match[3]}` : null;
}

function fullName(first?: string, last?: string): string {
  return `${first ?? ""} ${last ?? ""}`.trim() || "Customer";
}

function createSupabaseAdmin() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase env vars missing.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// --- Types ---
interface AcuityAppointment {
  id: number;
  datetime: string;
  endTime: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  status?: string;
  noShow?: boolean;
}
interface AcuityWebhookPayload {
  type: "appointment.scheduled" | "appointment.canceled" | "appointment.rescheduled";
  appointment: AcuityAppointment;
  calendarId: number;
}

// --- Webhook Handler ---
Deno.serve(async (req) => {
  console.log(`[AcuityWebhook] ${req.method} ${req.url}`);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  const contentType = req.headers.get("content-type") || "";
  let payload: AcuityWebhookPayload;

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const body = await req.text();
    console.log("[AcuityWebhook] Raw form body:", body);
    const params = new URLSearchParams(body);
    const action = params.get("action");
    const id = params.get("id");
    const calendarId = params.get("calendarID");

    if (!action || !id || !calendarId) {
      console.error("[AcuityWebhook] Missing 'action', 'id', or 'calendarID' in form payload.");
      return new Response("Bad Request: Missing fields", { status: 400, headers: corsHeaders });
    }

    payload = {
      type: action as AcuityWebhookPayload["type"],
      appointment: { id: Number(id) } as AcuityAppointment,
      calendarId: Number(calendarId),
    };
  } else {
    console.error("[AcuityWebhook] Unsupported content-type:", contentType);
    return new Response("Unsupported Media Type", { status: 415, headers: corsHeaders });
  }

  const appt = payload.appointment;
  if (!appt?.id) {
    console.warn("[AcuityWebhook] Missing appointment ID.");
    return new Response("OK", { status: 200, headers: corsHeaders });
  }

  try {
    const supabase = createSupabaseAdmin();
    const encryptionKey = Deno.env.get("CALENDAR_CREDENTIALS_ENCRYPTION_KEY");
    if (!encryptionKey) throw new Error("Missing CALENDAR_CREDENTIALS_ENCRYPTION_KEY");

    const { data: integration, error: intErr } = await supabase
      .from("calendar_integrations")
      .select("id, user_id, encrypted_credentials")
      .eq("provider", "acuity")
      .eq("status", "active_watching")
      .eq("acuity_calendar_id", payload.calendarId)
      .single();

    if (intErr) throw intErr;
    if (!integration) {
      console.warn("[AcuityWebhook] No active Acuity integration found.");
      return new Response("OK", { status: 200, headers: corsHeaders });
    }

    const tokens = await getValidCredentials(integration);
    const accessToken = tokens?.access_token;
    if (!accessToken) {
      console.error("[AcuityWebhook] Missing access_token in decrypted credentials.");
      return new Response("OK", { status: 200, headers: corsHeaders });
    }

    // Fetch full appointment
    const res = await fetch(`https://api.acuityscheduling.com/api/v1/appointments/${appt.id}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      console.error(`[AcuityWebhook] Failed to fetch appointment ${appt.id} (${res.status})`);
      return new Response("OK", { status: 200, headers: corsHeaders });
    }

    const fullAppt = await res.json() as AcuityAppointment;
    console.log(`[AcuityWebhook] integration.user_id ${integration.user_id}:`);

    function safeISO(input: string | undefined | null): string | null {
      if (!input) return null;
      const parsed = parseISO(input);
      return isValid(parsed) ? parsed.toISOString() : null;
    }

    const eventStart = safeISO(fullAppt.datetime);
    const eventEnd = safeISO(fullAppt.endTime);

    const { data: settingsRow, error: settingsErr } = await supabase
      .from("user_settings")
      .select("call_activation_settings")
      .eq("user_id", integration.user_id)
      .maybeSingle();

    if (settingsErr) throw settingsErr;

    const settings = settingsRow?.call_activation_settings || {};
    console.log(`[AcuityWebhook] Received ${payload.type} for appt ${fullAppt.id}. User settings:`, JSON.stringify(settings));
    const phone = parsePhone(fullAppt.phone);
    if (!phone) {
      console.log(`[AcuityWebhook] Skipping appt ${fullAppt.id}: no valid phone.`);
      return new Response("OK", { status: 200, headers: corsHeaders });
    }

    const name = fullName(fullAppt.firstName, fullAppt.lastName);
    const now = new Date().toISOString();
    let callType: "confirm_appointment" | "recover_cancellation" | "reschedule_noshow" | null = null;

    const start = parseISO(fullAppt.datetime);

    if (
      (payload.type === "appointment.scheduled" || payload.type === "appointment.rescheduled") &&
      settings.confirm_appointments?.enabled
    ) {
      console.log(`[AcuityWebhook] Checking if appointment ${fullAppt.id} qualifies for confirmation.`);
      if (isValid(start) && !isPast(start)) {
        console.log(`[AcuityWebhook] Appointment ${fullAppt.id} is valid and in the future. Marking for confirmation.`);
        callType = "confirm_appointment";
      } else {
        console.log(`[AcuityWebhook] Skipping past appointment ${fullAppt.id} for confirmation.`);
      }
    } else if (payload.type === "appointment.canceled") {
      if (fullAppt.noShow && settings.reschedule_noshows?.enabled) {
        console.log(`[AcuityWebhook] Appointment ${fullAppt.id} is canceled noshow. Marking for recovery.`);
        callType = "reschedule_noshow";
      } else if (!fullAppt.noShow && settings.recover_cancellations?.enabled) {
        console.log(`[AcuityWebhook] Appointment ${fullAppt.id} is canceled. Marking for recovery.`);
        callType = "recover_cancellation";
      }
    } else {
      console.log(`[AcuityWebhook] Appointment ${fullAppt.id} does not match any call activation criteria.`);
    }

    if (!callType) {
      console.log(`[AcuityWebhook] Appt ${fullAppt.id} did not qualify for any call.`);
      return new Response("OK", { status: 200, headers: corsHeaders });
    }

    const record = {
      user_id: integration.user_id,
      calendar_integration_id: integration.id,
      calendar_event_id: appt.id,
      event_start_time: eventStart,
      event_end_time: eventEnd,
      event_summary: name,
      customer_name: name,
      customer_phone: phone,
      call_type: callType,
      status: "pending",
      created_at: now,
      updated_at: now,
    };

    const { error: upsertErr } = await supabase
      .from("outbound_call_queue")
      .upsert(record, { onConflict: "calendar_event_id" });

    if (upsertErr) {
      console.error(`[AcuityWebhook] Failed to upsert call task for appt ${appt.id}`, upsertErr);
    } else {
      console.log(`[AcuityWebhook] Queued '${callType}' call for appt ${appt.id}.`);
    }

    return new Response("OK", { status: 200, headers: corsHeaders });

  } catch (err) {
    console.error("[AcuityWebhook] Uncaught error", err);
    return new Response("Internal Server Error", { status: 500, headers: corsHeaders });
  }
});

console.log("[INFO] Acuity Webhook Edge Function is active.");
