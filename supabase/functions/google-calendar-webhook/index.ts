// supabase/functions/google-calendar-webhook/index.ts
// Version: 3.1 - Removed scheduled_call_time from upsert payload
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7?target=deno"; // Keep pinned version for stability unless issues arise
import { google } from "https://esm.sh/googleapis@v134?target=deno"; // Pinning googleapis to a specific version known to work well with Deno
import { decode } from "https://deno.land/std@0.208.0/encoding/base64.ts";
import { add, sub, parseISO, isValid, isPast } from "https://esm.sh/date-fns@3.6.0?target=deno"; // Using specific version of date-fns
// --- Inlined Shared Code: corsHeaders ---
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-goog-channel-id, x-goog-resource-id, x-goog-resource-state',
  'Access-Control-Allow-Methods': 'POST, OPTIONS' // Methods allowed
};
// --- End Inlined corsHeaders ---
// --- Inlined Shared Code: encryption.ts ---
// Helper function to derive a cryptographic key from a string using SHA-256
async function deriveKey(keyString) {
  const encoder = new TextEncoder();
  const keyMaterial = encoder.encode(keyString);
  const keyDigest = await crypto.subtle.digest('SHA-256', keyMaterial);
  return await crypto.subtle.importKey('raw', keyDigest, {
    name: 'AES-GCM'
  }, false, [
    'encrypt',
    'decrypt'
  ]);
}
// Helper function to encrypt data using AES-GCM
async function encrypt(plainText, keyString) {
  if (!plainText || !keyString) {
    throw new Error("Encryption requires plain text and a key string.");
  }
  try {
    const cryptoKey = await deriveKey(keyString);
    const iv = crypto.getRandomValues(new Uint8Array(12)); // 12 bytes IV for AES-GCM
    const encodedData = new TextEncoder().encode(plainText);
    const encryptedData = await crypto.subtle.encrypt({
      name: "AES-GCM",
      iv: iv
    }, cryptoKey, encodedData);
    const encodeBase64 = (buf)=>{
      let binary = '';
      const bytes = new Uint8Array(buf);
      const len = bytes.byteLength;
      for(let i = 0; i < len; i++){
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    };
    return JSON.stringify({
      iv: encodeBase64(iv),
      data: encodeBase64(encryptedData)
    });
  } catch (error) {
    console.error("[ERROR] Encryption failed:", error);
    throw new Error(`Encryption failed: ${error.message}`);
  }
}
// Helper function to decrypt data using AES-GCM
async function decrypt(encryptedStr, keyString) {
  if (!encryptedStr || !keyString) {
    throw new Error("Decryption requires encrypted string and a key string.");
  }
  try {
    const { iv, data } = JSON.parse(encryptedStr);
    if (!iv || !data) {
      throw new Error("Invalid encrypted string format (missing iv or data).");
    }
    const cryptoKey = await deriveKey(keyString);
    const ivBytes = decode(iv);
    const dataBytes = decode(data);
    if (ivBytes.length !== 12) {
      console.warn(`[WARN] Decryption IV length is ${ivBytes.length}, standard is 12.`);
    }
    const decryptedData = await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: ivBytes
    }, cryptoKey, dataBytes);
    return new TextDecoder().decode(decryptedData);
  } catch (error) {
    console.error("[ERROR] Decryption failed:", error);
    if (error instanceof DOMException && error.name === 'OperationError') {
      console.error("[ERROR] Decryption OperationError: Likely incorrect key or corrupted data.");
      throw new Error("Decryption failed: Incorrect key or corrupted data.");
    }
    throw new Error(`Decryption failed: ${error.message}`);
  }
}
// --- End Inlined encryption.ts ---
// --- Helper Functions ---
// Creates an authenticated Supabase client
function createSupabaseAdmin() {
  console.log("--- ENTERING createSupabaseAdmin ---");
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  console.log(`[DEBUG] Raw env vars: SUPABASE_URL exists=${!!url}, SUPABASE_SERVICE_ROLE_KEY exists=${!!key}`);
  if (!url) throw new Error('Server Config Error: SUPABASE_URL is not set.');
  if (!key) throw new Error('Server Config Error: SUPABASE_SERVICE_ROLE_KEY is not set.');
  try {
    console.log("[DEBUG] Creating Supabase client (Deno ESM)...");
    const client = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
    if (!client || typeof client.from !== 'function') {
      throw new Error("Failed to create a valid Supabase client object.");
    }
    console.log("[DEBUG] Supabase admin client appears valid after creation.");
    return client;
  } catch (error) {
    console.error("[FATAL_ERROR] Error creating Supabase client:", error);
    throw error;
  }
}
// Parses customer info from event (unchanged from v3)
function parseCustomerInfo(event) {
  const description = event.description ?? '';
  const location = event.location ?? '';
  const summary = event.summary ?? '';
  let phone = null;
  let name = null;
  const phoneRegex = /(?:phone:|tel:)?\s*\(?([2-9]\d{2})\)?[-.\s]?([2-9]\d{2})[-.\s]?(\d{4})/i;
  let phoneMatch = description.match(phoneRegex) || location.match(phoneRegex) || summary.match(phoneRegex);
  if (phoneMatch) {
    phone = `+1${phoneMatch[1]}${phoneMatch[2]}${phoneMatch[3]}`;
  }
  const simpleNameRegex = /(?:with|client:)\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z]?[a-zA-Z'-]+)*)/i;
  let nameMatch = summary.match(simpleNameRegex);
  if (nameMatch && nameMatch[1]) {
    name = nameMatch[1].trim();
  } else if (event.attendees) {
    const firstGuest = event.attendees.find((att)=>att.responseStatus !== 'organizer' && !att.self);
    if (firstGuest?.displayName) {
      name = firstGuest.displayName.trim();
    } else if (firstGuest?.email) {
      name = firstGuest.email.split('@')[0].replace(/[^a-zA-Z\s]+/g, ' ').replace(/\./g, ' ').trim().replace(/\s+/g, ' ').replace(/\b\w/g, (l)=>l.toUpperCase());
    }
  }
  if (!name && summary) {
    const summaryNameRegex = /^([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+)+)/;
    const summaryMatch = summary.match(summaryNameRegex);
    if (summaryMatch && summaryMatch[1] && summaryMatch[1].includes(' ')) {
      name = summaryMatch[1];
    }
  }
  if (!name) name = 'Customer';
  if (phone && !/^\+1[2-9]\d{9}$/.test(phone)) {
    console.warn(`[WARN] Invalid phone format extracted: ${phone}. Discarding.`);
    phone = null;
  }
  console.log(`[Webhook] Parsed Info for event ${event.id}: Name='${name}', Phone='${phone}'`);
  return {
    name,
    phone
  };
}
// Calculates a target time (still used for eligibility, just not inserted)
function calculateTargetTime(baseTimeISO, timingValue, timingUnit, addOrSub) {
  if (!baseTimeISO) {
    console.warn(`[WARN] Cannot calculate target time: baseTimeISO is missing.`);
    return null;
  }
  try {
    const baseDate = parseISO(baseTimeISO);
    if (!isValid(baseDate)) {
      console.warn(`[WARN] Cannot calculate target time: Invalid baseTimeISO format: ${baseTimeISO}`);
      return null;
    }
    const duration = {}; // Use 'any' to avoid index signature issues with date-fns duration
    switch(timingUnit){
      case 'minutes':
        duration.minutes = timingValue;
        break;
      case 'hours':
        duration.hours = timingValue;
        break;
      case 'days':
        duration.days = timingValue;
        break;
      default:
        console.warn(`[WARN] Invalid timing unit provided: ${timingUnit}`);
        return null;
    }
    const targetDate = addOrSub === 'add' ? add(baseDate, duration) : sub(baseDate, duration);
    return targetDate.toISOString();
  } catch (e) {
    console.error(`[ERROR] Error calculating target time from base ${baseTimeISO}:`, e);
    return null;
  }
}
// --- End Helper Functions ---
// --- Main Webhook Handler ---
Deno.serve(async (req)=>{
  // --- Initial Request Handling & Header Validation ---
  console.log(`--- [INFO][Webhook v3.1] Request received: ${req.method} ${req.url} ---`);
  if (req.method === 'OPTIONS') return new Response(null, {
    headers: corsHeaders
  });
  if (req.method !== 'POST') return new Response('Method Not Allowed', {
    status: 405,
    headers: corsHeaders
  });
  const channelId = req.headers.get('X-Goog-Channel-ID');
  const resourceId = req.headers.get('X-Goog-Resource-ID');
  const resourceState = req.headers.get('X-Goog-Resource-State');
  console.log(`[INFO][Webhook] Headers: ChannelId=${channelId}, ResourceId=${resourceId}, State=${resourceState}`);
  if (!channelId || !resourceId || !resourceState) {
    console.warn('[WARN][Webhook] Forbidden: Missing required Google headers.');
    return new Response('Forbidden: Missing Google headers', {
      status: 403
    });
  }
  // Acknowledge Google immediately
  const ackResponse = new Response('Webhook received successfully.', {
    status: 200,
    headers: corsHeaders
  });
  // --- Asynchronous Processing ---
  (async ()=>{
    let supabaseAdmin = null;
    let integration = null; // Define type more specifically if needed
    let encryptionKey = undefined;
    try {
      console.log("[DEBUG][Webhook] Starting asynchronous processing...");
      if (resourceState === 'sync' || resourceState !== 'exists') {
        console.log(`[INFO] Ignoring resource state: ${resourceState}`);
        return;
      }
      // --- Step 0: Initialize Supabase Client ---
      supabaseAdmin = createSupabaseAdmin();
      // --- Step 1: Fetch Active Integration ---
      integration = await (async ()=>{
        console.log("[STEP_DEBUG] 1. Finding active integration...");
        const { data, error } = await supabaseAdmin.from('calendar_integrations').select('id, user_id, encrypted_credentials, google_calendar_id, last_sync_token').eq('google_watch_channel_id', channelId).eq('google_watch_resource_id', resourceId).eq('status', 'active_watching').maybeSingle();
        if (error) throw new Error(`DB error fetching integration: ${error.message}`);
        if (!data) {
          console.warn(`[WARN] No active integration found for channel ${channelId} / resource ${resourceId}.`);
          return null;
        }
        console.log(`[STEP_DEBUG] 1a. Found integration ID: ${data.id}, User ID: ${data.user_id}, Sync Token: ${data.last_sync_token ? 'Exists' : 'None'}`);
        return data;
      })();
      if (!integration) return; // Stop if no integration found
      // --- Step 2: Update Last Webhook Timestamp ---
      await (async ()=>{
        console.log(`[STEP_DEBUG] 2. Updating last_webhook_at for integration ${integration.id}...`);
        const { error } = await supabaseAdmin.from('calendar_integrations').update({
          last_webhook_at: new Date().toISOString()
        }).eq('id', integration.id);
        if (error) console.warn(`[WARN] Failed to update last_webhook_at: ${error.message}`);
        else console.log("[STEP_DEBUG] 2a. Timestamp updated.");
      })();
      // --- Step 3: Fetch User Settings ---
      const userSettings = await (async ()=>{
        console.log(`[STEP_DEBUG] 3. Fetching settings for user ${integration.user_id}...`);
        const { data, error } = await supabaseAdmin.from('user_settings').select('call_activation_settings') // Select the JSONB column
        .eq('user_id', integration.user_id).maybeSingle();
        if (error) throw new Error(`DB error fetching settings: ${error.message}`);
        // Check if settings exist and the JSONB is not null/empty
        if (!data || !data.call_activation_settings || Object.keys(data.call_activation_settings).length === 0) {
          console.log(`[INFO] User ${integration.user_id} has no call_activation_settings or settings are empty. Skipping.`);
          return null;
        }
        console.log("[STEP_DEBUG] 3a. Found call settings:", data.call_activation_settings);
        return data; // Cast to expected type
      })();
      if (!userSettings) return; // Stop if no settings
      // --- Step 4: Check Enabled Settings ---
      const relevantSettings = userSettings.call_activation_settings;
      // Check if *any* of the call types within the settings object are enabled
      const anyCallEnabled = relevantSettings && (relevantSettings.confirm_appointments?.enabled || relevantSettings.recover_cancellations?.enabled || relevantSettings.reschedule_noshows?.enabled);
      if (!anyCallEnabled) {
        console.log(`[INFO] No relevant call types enabled in user settings. Skipping event processing.`);
        return;
      }
      console.log("[STEP_DEBUG] 4a. At least one relevant call type enabled.");
      // --- Step 5: Decrypt Credentials ---
      const credentials = await (async ()=>{
        console.log("[STEP_DEBUG] 5. Decrypting credentials...");
        encryptionKey = Deno.env.get('CALENDAR_CREDENTIALS_ENCRYPTION_KEY');
        if (!encryptionKey) throw new Error("Server Config Error: CALENDAR_CREDENTIALS_ENCRYPTION_KEY missing.");
        if (!integration.encrypted_credentials) throw new Error(`Integration ${integration.id} missing credentials.`);
        const decryptedJson = await decrypt(integration.encrypted_credentials, encryptionKey);
        const creds = JSON.parse(decryptedJson); // Parse the decrypted JSON string
        if (!creds.access_token || !creds.refresh_token) {
          console.warn("[WARN] Decrypted credentials missing access_token or refresh_token. API calls might fail.");
        // Depending on strictness, you might want to throw an error here
        }
        console.log("[STEP_DEBUG] 5a. Credentials decrypted.");
        return creds; // Return the parsed credentials object
      })();
      // --- Step 6: Setup Google Client & Refresh Listener ---
      const oauth2Client = (()=>{
        console.log("[STEP_DEBUG] 6. Setting up Google client...");
        const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
        const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
        if (!clientId || !clientSecret) throw new Error("Server Config Error: Google client ID/secret missing.");
        const client = new google.auth.OAuth2(clientId, clientSecret);
        client.setCredentials(credentials); // Set the decrypted credentials
        // Setup token refresh listener
        client.on('tokens', async (newTokens)=>{
          console.warn("[WARN] Google OAuth token refresh occurred. Saving new tokens...");
          if (!supabaseAdmin || !integration || !encryptionKey) {
            console.error("[ERROR] Cannot save refreshed tokens: Context missing (Supabase, integration, or key).");
            return;
          }
          let updatedCredentials = {
            ...credentials
          }; // Start with existing credentials
          if (newTokens.refresh_token) updatedCredentials.refresh_token = newTokens.refresh_token;
          if (newTokens.access_token) updatedCredentials.access_token = newTokens.access_token;
          if (newTokens.expiry_date) updatedCredentials.expiry_date = newTokens.expiry_date;
          // Optional: update scope and token_type if they might change
          // if (newTokens.scope) updatedCredentials.scope = newTokens.scope;
          // if (newTokens.token_type) updatedCredentials.token_type = newTokens.token_type;
          try {
            const newEncryptedCredentials = await encrypt(JSON.stringify(updatedCredentials), encryptionKey);
            const { error: tokenSaveError } = await supabaseAdmin.from('calendar_integrations').update({
              encrypted_credentials: newEncryptedCredentials
            }).eq('id', integration.id);
            if (tokenSaveError) {
              console.error(`[ERROR] Failed to save refreshed tokens to DB:`, tokenSaveError.message);
            } else {
              console.log(`[INFO] Successfully saved refreshed tokens to DB for integration ${integration.id}.`);
              // Update the client instance with the absolute latest credentials
              client.setCredentials(updatedCredentials);
            }
          } catch (encryptError) {
            console.error(`[ERROR] Failed to encrypt new tokens:`, encryptError);
          }
        });
        console.log("[STEP_DEBUG] 6a. OAuth client ready.");
        return client;
      })();
      // --- Step 7: Fetch Google Calendar Events ---
      const { events, nextSyncToken } = await (async ()=>{
        const calendar = google.calendar({
          version: 'v3',
          auth: oauth2Client
        });
        const calendarId = integration.google_calendar_id || 'primary';
        if (!calendarId || typeof calendarId !== 'string' || calendarId.trim().length === 0) {
          throw new Error(`Invalid Calendar ID configured: '${calendarId}'`);
        }
        const listParams = {
          calendarId,
          maxResults: 250,
          singleEvents: true,
          showDeleted: true,
          timeZone: 'UTC'
        };
        if (integration.last_sync_token) {
          console.log(`[STEP_DEBUG] 7. Fetching events using sync token...`);
          listParams.syncToken = integration.last_sync_token;
        } else {
          // No sync token, likely first sync or lost token. Fetch recent updates.
          const updatedMin = sub(new Date(), {
            minutes: 10
          }).toISOString(); // Look back 10 mins
          console.log(`[STEP_DEBUG] 7. Performing initial/re-sync using updatedMin (${updatedMin})...`);
          listParams.updatedMin = updatedMin;
          listParams.orderBy = 'updated'; // Order by update time for consistency
        }
        console.log("[DEBUG] Calling calendar.events.list with params:", listParams);
        try {
          const response = await calendar.events.list(listParams);
          const fetchedEvents = response.data.items || [];
          const syncToken = response.data.nextSyncToken; // This might be null
          console.log(`[STEP_DEBUG] 7c. Fetched ${fetchedEvents.length} events. Next sync token ${syncToken ? 'received' : 'not received'}.`);
          return {
            events: fetchedEvents,
            nextSyncToken: syncToken
          };
        } catch (err) {
          console.error("[ERROR] Google Calendar API list events call failed:", err.message || err);
          // Handle specific errors like 410 Gone (Invalid Sync Token)
          if (err.code === 410 && integration && supabaseAdmin) {
            console.warn(`[WARN] Sync token invalid (410 Gone) for integration ${integration.id}. Clearing token.`);
            try {
              const { error: clearTokenError } = await supabaseAdmin.from('calendar_integrations').update({
                last_sync_token: null
              }).eq('id', integration.id);
              if (clearTokenError) console.error(`[ERROR] Failed to clear invalid sync token in DB:`, clearTokenError.message);
              else console.log(`[INFO] Invalid sync token cleared in DB.`);
            } catch (dbUpdateError) {
              console.error(`[ERROR] Exception while clearing invalid sync token:`, dbUpdateError);
            }
            // Stop processing for this webhook invocation, need a full sync next time
            throw new Error("Sync token was invalid (410 Gone). Requires full re-sync.");
          } else if (supabaseAdmin && integration) {
            // Handle other common errors by updating integration status
            let statusUpdate = {
              status: 'error_google_api',
              status_message: `Google API error: ${err.message}`
            };
            if (err.code === 401 || err.message?.includes('invalid_grant') || err.message?.includes('Invalid Credentials')) {
              statusUpdate = {
                status: 'error_invalid_credentials',
                status_message: 'Google auth failed.'
              };
            } else if (err.code === 404 && err.message?.includes('Not Found')) {
              statusUpdate = {
                status: 'error_calendar_not_found',
                status_message: `Calendar ID '${calendarId}' not found.`
              };
            } else if (err.code === 403 && err.message?.includes('forbidden')) {
              statusUpdate = {
                status: 'error_google_api_permissions',
                status_message: 'Permission denied for Google Calendar API.'
              };
            }
            console.error(`[ERROR] Updating integration ${integration.id} status to '${statusUpdate.status}'.`);
            await supabaseAdmin.from('calendar_integrations').update(statusUpdate).eq('id', integration.id);
          } else {
            console.error("[ERROR] Cannot update integration status - Supabase client or integration object missing.");
          }
          throw err; // Re-throw the original error
        }
      })();
      // --- Step 7d: Save New Sync Token ---
      if (nextSyncToken && integration && supabaseAdmin) {
        console.log(`[STEP_DEBUG] 7d. Saving new sync token...`);
        const { error: syncTokenSaveError } = await supabaseAdmin.from('calendar_integrations').update({
          last_sync_token: nextSyncToken
        }).eq('id', integration.id);
        if (syncTokenSaveError) {
          console.error(`[ERROR] Failed to save nextSyncToken to DB:`, syncTokenSaveError.message);
        } else {
          console.log(`[INFO] Successfully saved nextSyncToken for integration ${integration.id}.`);
          integration.last_sync_token = nextSyncToken; // Update in-memory object too
        }
      } else if (!nextSyncToken && integration?.last_sync_token) {
        // This can happen if there are no changes since the last sync token was issued.
        console.warn(`[WARN] Sync token was used, but no nextSyncToken received from Google. This may indicate no changes.`);
      }
      // --- Step 8: Process Events with Upsert Logic ---
      console.log(`[STEP_DEBUG] 8. Processing ${events.length} fetched events with upsert logic...`);
      const CONFIRM_APPOINTMENT_ENUM = 'confirm_appointment';
      const RECOVER_CANCELLATION_ENUM = 'recover_cancellation';
      const RESCHEDULE_NOSHOW_ENUM = 'reschedule_noshow';
      const SKIPPED_STATUS = 'skipped'; // Status for obsolete/cancelled tasks
      for (const event of events){
        if (!event || !event.id) {
          console.warn("[WARN] Skipping event: missing data or ID.");
          continue;
        }
        console.log(`[DEBUG] Processing Event ID=${event.id}, Status=${event.status}, Summary=${event.summary}`);
        const eventStartTimeStr = event.start?.dateTime || event.start?.date;
        if (!eventStartTimeStr) {
          console.log(`[INFO] Skipping event ${event.id}: Missing start time.`);
          continue;
        }
        const { name, phone } = parseCustomerInfo(event);
        if (!phone) {
          console.log(`[INFO] Skipping event ${event.id}: No valid phone number found.`);
          continue;
        }
        const customerName = name || 'Customer'; // Use parsed name or default
        if (!name) console.warn(`[WARN] Event ${event.id}: Using default name '${customerName}'.`);
        let callType = null;
        let targetTime = null; // Use targetTime conceptually for eligibility checks
        let baseTimeForCalc = eventStartTimeStr;
        let shouldSkipBecausePast = false;
        // --- Determine Call Type & Eligibility ---
        if (event.status === 'confirmed') {
          if (relevantSettings?.confirm_appointments?.enabled) {
            const setting = relevantSettings.confirm_appointments;
            const eventStartDate = parseISO(eventStartTimeStr);
            if (isValid(eventStartDate) && isPast(eventStartDate)) {
              console.log(`[INFO] Skipping confirmation task creation for past event ${event.id} (Start: ${eventStartTimeStr})`);
              shouldSkipBecausePast = true; // Mark to skip upsert
            } else {
              console.log(`[DEBUG] Event ${event.id} confirmed. Checking setting for '${CONFIRM_APPOINTMENT_ENUM}'.`);
              callType = CONFIRM_APPOINTMENT_ENUM;
              // Calculate time for potential logging/debug, but won't insert it
              targetTime = calculateTargetTime(baseTimeForCalc, setting.timing_value, setting.timing_unit, 'sub');
              if (!targetTime) console.warn(`[WARN] Failed to calculate target time for confirmation check: ${event.id}. Task might still be queued if timing settings valid.`);
            }
          }
        } else if (event.status === 'cancelled') {
          if (relevantSettings?.recover_cancellations?.enabled) {
            const setting = relevantSettings.recover_cancellations;
            console.log(`[DEBUG] Event ${event.id} cancelled. Checking setting for '${RECOVER_CANCELLATION_ENUM}'.`);
            callType = RECOVER_CANCELLATION_ENUM;
            baseTimeForCalc = new Date().toISOString(); // Base recovery on 'now'
            // Calculate time for potential logging/debug, but won't insert it
            targetTime = calculateTargetTime(baseTimeForCalc, setting.timing_value, setting.timing_unit, 'add');
            if (!targetTime) console.warn(`[WARN] Failed to calculate target time for cancellation recovery check: ${event.id}. Task might still be queued if timing settings valid.`);
          }
        }
        // Example for no-show (You'd need logic to determine if an event was a no-show)
        // else if (/* logic to determine no-show */ && relevantSettings?.reschedule_noshows?.enabled) {
        //    const setting = relevantSettings.reschedule_noshows;
        //    console.log(`[DEBUG] Event ${event.id} is no-show. Checking setting for '${RESCHEDULE_NOSHOW_ENUM}'.`);
        //    callType = RESCHEDULE_NOSHOW_ENUM;
        //    baseTimeForCalc = eventStartTimeStr; // Or maybe event end time?
        //    targetTime = calculateTargetTime(baseTimeForCalc, setting.timing_value, setting.timing_unit, 'add');
        // }
        // --- Perform Upsert or Skip ---
        // Upsert if a call type was determined, it wasn't skipped for being in the past,
        // and the necessary integration/client objects are available.
        // We no longer strictly require targetTime to be calculated successfully to queue,
        // as the processor handles timing based on last_attempt_time.
        if (callType && !shouldSkipBecausePast && integration && supabaseAdmin) {
          // *** REMOVE scheduled_call_time from the record ***
          const callRecord = {
            user_id: integration.user_id,
            calendar_integration_id: integration.id,
            calendar_event_id: event.id,
            event_start_time: event.start?.dateTime || event.start?.date || null,
            event_end_time: event.end?.dateTime || event.end?.date || null,
            event_summary: event.summary || null,
            customer_name: customerName,
            customer_phone: phone,
            call_type: callType,
            // scheduled_call_time: targetTime, // REMOVED THIS LINE
            status: 'pending',
            updated_at: new Date().toISOString()
          };
          console.log(`[DEBUG] Upserting task for Event ID ${event.id}, Type: ${callType}`);
          const { error: upsertError } = await supabaseAdmin.from('outbound_call_queue').upsert(callRecord, {
            onConflict: 'calendar_event_id'
          }); // Use unique constraint
          if (upsertError) {
            // Log the specific error, especially if it's schema related
            console.error(`[ERROR] Failed upsert task for Event ${event.id}, Type ${callType}:`, upsertError.message, upsertError);
          } else {
            console.log(`[INFO] Success upsert task for Event ${event.id}, Type ${callType}.`);
            // Handle obsolete confirmation task if a cancellation task was just upserted
            if (callType === RECOVER_CANCELLATION_ENUM) {
              console.log(`[DEBUG] Cancellation task upserted for ${event.id}. Marking any active confirmation task as '${SKIPPED_STATUS}'.`);
              const { error: updateError } = await supabaseAdmin.from('outbound_call_queue').update({
                status: SKIPPED_STATUS,
                updated_at: new Date().toISOString()
              }).eq('calendar_event_id', event.id) // Match the same event
              .eq('call_type', CONFIRM_APPOINTMENT_ENUM) // Target the confirmation call type
              .in('status', [
                'pending',
                'processing'
              ]); // Only skip if currently active
              if (updateError) {
                console.error(`[ERROR] Failed to update obsolete confirmation task for ${event.id} to skipped:`, updateError.message);
              } else {
                // Check if any rows were actually updated if needed (response doesn't guarantee it)
                console.log(`[INFO] Attempted to mark obsolete confirmation task as '${SKIPPED_STATUS}' for ${event.id}.`);
              }
            }
          }
        } else if (shouldSkipBecausePast) {
        // Already logged why it was skipped
        } else {
          // Log why no task was queued if callType was determined but something else failed, or if no type matched
          if (callType) {
            console.warn(`[WARN] Event ${event.id}: Qualified for ${callType} but skipped due to missing integration/client or other pre-upsert issue.`);
          } else {
            console.log(`[DEBUG] Event ${event.id} (Status: ${event.status}) did not qualify for any enabled call types. No task queued.`);
          }
        }
      } // End event processing loop
      console.log("[STEP_DEBUG] 8a. Event processing loop with upserts complete.");
    } catch (err) {
      // --- Fatal Error Handling (unchanged) ---
      console.error("[FATAL] Uncaught error during webhook async processing:", err);
      if (err.stack) console.error("Stack trace:", err.stack);
      if (supabaseAdmin && integration?.id) {
        try {
          // Check current status before overwriting to avoid masking specific Google API errors
          const { data: currentStatusData, error: statusCheckError } = await supabaseAdmin.from('calendar_integrations').select('status').eq('id', integration.id).single();
          if (statusCheckError) {
            console.error(`[ERROR] Failed to check current integration status before error update:`, statusCheckError);
          } else if (!currentStatusData?.status?.startsWith('error_')) {
            // Only update if not already in a specific error state
            console.log(`[DEBUG] Updating integration status to 'error_webhook_processing'.`);
            await supabaseAdmin.from('calendar_integrations').update({
              status: 'error_webhook_processing',
              status_message: `Webhook processing failed: ${err.message?.substring(0, 200) || 'Unknown error'}`
            }).eq('id', integration.id);
          } else {
            console.log(`[DEBUG] Integration already in error state '${currentStatusData?.status}', not overwriting with generic webhook error.`);
          }
        } catch (updateErr) {
          console.error(`[ERROR] Failed to update integration status after fatal error:`, updateErr);
        }
      }
    } finally{
      console.log("[DEBUG] Asynchronous webhook processing finished.");
    }
  })(); // End async IIFE
  return ackResponse; // Acknowledge Google immediately
});
console.log("[INFO] Google Calendar Webhook Edge Function Initialized and Listening (v3.1).");
