// supabase/functions/square-calendar-webhook/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseISO, isValid, isPast } from "https://esm.sh/date-fns@3.6.0";
import { getValidCredentials } from "../_shared/calendar-helpers.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, PUT, DELETE",
};

console.log("[INFO] Square Calendar Webhook handler initialized.");

const FUNCTION_VERSION = "2025-05-15_01";

function createSupabaseAdminClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("[FATAL] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    throw new Error("Server misconfiguration.");
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function parsePhone(raw?: string | null): string | null {
  if (!raw) return null;
  const match = raw.match(/^(?:\+?1)?\D*([2-9]\d{2})\D*([2-9]\d{2})\D*(\d{4})$/);
  return match ? `+1${match[1]}${match[2]}${match[3]}` : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let body;
  try {
    body = await req.json();
  } catch (err) {
    console.error("[ERROR] Failed to parse webhook payload:", err);
    return new Response(JSON.stringify({ error: "Invalid JSON." }), {
      status: 400,
      headers: corsHeaders,
    });
  }

  const eventType = body.type;
  const merchantId = body.merchant_id;
  const eventId = body.event_id;

  if (!merchantId || !eventType) {
    return new Response(JSON.stringify({ error: "Missing required fields." }), {
      status: 400,
      headers: corsHeaders,
    });
  }

  console.log(`[INFO] (${FUNCTION_VERSION}) Webhook received: ${eventType}, Merchant=${merchantId}`);

  const supabase = createSupabaseAdminClient();

  const { data: integration, error: integrationErr } = await supabase
    .from("calendar_integrations")
    .select("id, user_id, encrypted_credentials")
    .eq("provider", "square")
    .eq("square_merchant_id", merchantId)
    .single();

  if (integrationErr || !integration) {
    console.warn(`[WARN] (${FUNCTION_VERSION}) No integration found for merchant_id: ${merchantId}`);
    return new Response("No matching integration.", { status: 204, headers: corsHeaders });
  }

  console.log(`[INFO] (${FUNCTION_VERSION}) Found integration: id=${integration.id}, user_id=${integration.user_id}`);

  const encryptedCreds = integration.encrypted_credentials;
  const encryptionKey = Deno.env.get("CALENDAR_CREDENTIALS_ENCRYPTION_KEY");
  if (!encryptedCreds || !encryptionKey) {
    console.error("[ERROR] Missing credentials or encryption key.");
    return new Response("Server config error.", { status: 500, headers: corsHeaders });
  }

  const tokens = await getValidCredentials(integration);
  const accessToken = tokens?.access_token;
  if (!accessToken) {
    console.error("[SquareWebhook] Missing access_token in decrypted credentials.");
    return new Response("OK", { status: 200, headers: corsHeaders });
  }

  const bookingId = body?.data?.object?.booking?.id;
  console.log(`[INFO] (${FUNCTION_VERSION}) Booking body: ${JSON.stringify(body)}`);
  if (!bookingId) {
    console.warn(`[WARN] (${FUNCTION_VERSION}) Webhook missing booking_id.`);
    return new Response("Missing booking_id.", { status: 400, headers: corsHeaders });
  }

  console.log(`[INFO] (${FUNCTION_VERSION}) Fetching booking details for booking_id=${bookingId}...`);

  const squareApiV = "2025-04-16";
  const bookingRes = await fetch(`https://connect.squareup.com/v2/bookings/${bookingId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Square-Version": squareApiV,
      "Content-Type": "application/json",
    },
  });

  if (!bookingRes.ok) {
    console.error(`[ERROR] Failed to fetch booking ${bookingId}: ${bookingRes.status}`);
    const errorText = await bookingRes.text();
    console.error(`[ERROR] Square booking fetch failed: ${bookingRes.status} - ${errorText}`);

    return new Response("Failed to fetch booking.", { status: 502, headers: corsHeaders });
  }

  const bookingData = await bookingRes.json();
  const booking = bookingData.booking;
  if (!booking) {
    console.error(`[ERROR] Booking response did not contain 'booking' object.`);
    return new Response("Booking not found in response.", { status: 500, headers: corsHeaders });
  }

  console.log(`[INFO] (${FUNCTION_VERSION}) Booking fetched: ${booking.id}, Start: ${booking.start_at}`);

  let customerPhone: string | null = null;
  let customerName = "Customer";

  if (booking.customer_id) {
    console.log(`[INFO] (${FUNCTION_VERSION}) Fetching customer info for customer_id=${booking.customer_id}...`);
    const custRes = await fetch(`https://connect.squareup.com/v2/customers/${booking.customer_id}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Square-Version": squareApiV,
        "Content-Type": "application/json",
      },
    });

    if (custRes.ok) {
      const custData = await custRes.json();
      customerPhone = parsePhone(custData.customer?.phone_number);
      customerName = custData.customer?.given_name || customerName;
      console.log(`[INFO] (${FUNCTION_VERSION}) Customer resolved: ${customerName}, Phone: ${customerPhone}`);
    } else {
      console.warn(`[WARN] (${FUNCTION_VERSION}) Failed to fetch customer details.`);
    }
  }

  if (!customerPhone) {
    console.log(`[INFO] (${FUNCTION_VERSION}) Skipping booking ${booking.id}: no valid phone.`);
    return new Response("No valid phone.", { status: 200, headers: corsHeaders });
  }

  const { data: settingsRow, error: settingsErr } = await supabase
    .from("user_settings")
    .select("call_activation_settings")
    .eq("user_id", integration.user_id)
    .maybeSingle();

  if (settingsErr) {
    console.error("[ERROR] Failed to fetch user settings:", settingsErr);
    return new Response("Settings error.", { status: 500, headers: corsHeaders });
  }

  console.log(`[INFO] (${FUNCTION_VERSION}) User settings loaded for user_id=${integration.user_id}`);

  const settings = settingsRow?.call_activation_settings || {};
  type CallType = "confirm_appointment" | "recover_cancellation";
  let callType: CallType | null = null;

  if (
    (eventType === "booking.created" || eventType === "booking.updated") &&
    settings.confirm_appointments?.enabled
  ) {
    const start = parseISO(booking.start_at);
    if (isValid(start) && !isPast(start)) {
      callType = "confirm_appointment";
      console.log(`[INFO] (${FUNCTION_VERSION}) Booking eligible for confirmation call.`);
    } else {
      console.log(`[INFO] Skipping confirmation: booking ${booking.id} is in the past.`);
    }
  }
  
  const cancelStatus = booking.status || "";
  if (
    eventType === "booking.updated" &&
    (cancelStatus === "CANCELLED_BY_CUSTOMER" || cancelStatus === "CANCELLED_BY_SELLER") &&
    settings.recover_cancellations?.enabled
  ) {
    callType = "recover_cancellation";
    console.log(`[INFO] (${FUNCTION_VERSION}) Booking cancellation detected; recovery call enabled.`);
  }

  if (!callType) {
    console.log(`[INFO] No call type triggered for booking ${booking.id}`);
    return new Response("No action taken.", { status: 200, headers: corsHeaders });
  }

  const record = {
    user_id: integration.user_id,
    calendar_integration_id: integration.id,
    calendar_event_id: booking.id,
    event_start_time: booking.start_at,
    event_end_time: booking.end_at,
    event_summary: booking.customer_note ?? null,
    customer_name: customerName,
    customer_phone: customerPhone,
    call_type: callType,
    status: "pending",
    updated_at: new Date().toISOString(),
  };

  console.log(`[INFO] (${FUNCTION_VERSION}) Queuing call: type=${callType}, booking_id=${booking.id}`);

  const { error: queueErr } = await supabase
    .from("outbound_call_queue")
    .upsert(record, { onConflict: "calendar_event_id" });

  if (queueErr) {
    console.error("[ERROR] Failed to queue call:", queueErr);
    return new Response("Failed to queue call.", { status: 500, headers: corsHeaders });
  }

  console.log(`[SUCCESS] (${FUNCTION_VERSION}) Call successfully queued: type=${callType}, booking_id=${booking.id}`);

  return new Response("Call queued.", { status: 200, headers: corsHeaders });

});
