// supabase/functions/calendar-callback/index.ts
// Version: 2025-05-14_01 (Calendly user_uri & org_uri storage, refined Square user info)
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { google as googleapis } from "https://esm.sh/googleapis@v134?target=deno";
import { v4 as uuidv4 } from "https://esm.sh/uuid@9";
import { encode } from "https://deno.land/std@0.208.0/encoding/base64.ts";
// --- Shared Code (Encryption, CORS) ---
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE'
};

async function deriveKey(keyString: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = encoder.encode(keyString);
  const keyDigest = await crypto.subtle.digest('SHA-256', keyMaterial);
  return crypto.subtle.importKey('raw', keyDigest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encrypt(text: string, keyString: string): Promise<string> {
  if (!text || !keyString) throw new Error("Encryption requires text and a key string.");
  try {
    const cryptoKey = await deriveKey(keyString);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encodedText = new TextEncoder().encode(text);
    const encryptedData = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, cryptoKey, encodedText);
    return JSON.stringify({ iv: encode(iv), data: encode(new Uint8Array(encryptedData)) });
  } catch (error: any) {
    console.error("[ERROR] Encryption failed:", error);
    throw new Error(`Encryption failed: ${error.message}`);
  }
}
// --- End Shared Code ---

const FUNCTION_VERSION = "2025-05-14_01"; // --- MODIFIED --- Version Bump
console.log(`[INFO] calendar-callback function booting. Version: ${FUNCTION_VERSION}`);

type CalendarProviderKey = "google" | "acuity" | "calendly" | "square";

interface UserInfo {
    email: string;
    id?: string; // Provider-specific ID (e.g., Google sub, Calendly user URI, Square merchant_id)
    name?: string;
    // --- NEW: Added for Calendly ---
    calendly_user_uri?: string;
    calendly_organization_uri?: string;
    // --- END NEW ---
}

interface OAuthProviderDetails {
    clientIdEnvVar: string;
    clientSecretEnvVar: string;
    tokenUrl: string;
    userInfoUrl?: string; 
    scopes?: string[]; 
    getUserInfo: (tokens: any, providerConfig: OAuthProviderDetails, functionRedirectUri: string, clientId: string, clientSecret: string, provider: CalendarProviderKey) => Promise<UserInfo>;
}


const PROVIDER_DETAILS: Record<CalendarProviderKey, OAuthProviderDetails> = {
    google: {
        clientIdEnvVar: "GOOGLE_CLIENT_ID",
        clientSecretEnvVar: "GOOGLE_CLIENT_SECRET",
        tokenUrl: "https://oauth2.googleapis.com/token", 
        userInfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo", 
        getUserInfo: async (tokens, _providerConfig, functionRedirectUri, clientId, clientSecret) => {
            const oauth2Client = new googleapis.auth.OAuth2(clientId, clientSecret, functionRedirectUri);
            oauth2Client.setCredentials(tokens);
            const oauth2 = googleapis.oauth2({ version: 'v2', auth: oauth2Client });
            const userInfoResponse = await oauth2.userinfo.get();
            if (!userInfoResponse.data.email) throw new Error("Google user info did not return email.");
            return { email: userInfoResponse.data.email, id: userInfoResponse.data.id };
        },
    },
    acuity: {
        clientIdEnvVar: "ACUITY_CLIENT_ID",
        clientSecretEnvVar: "ACUITY_CLIENT_SECRET",
        tokenUrl: "https://api.acuityscheduling.com/oauth2/token",
        userInfoUrl: "https://api.acuityscheduling.com/api/v1/me",
        getUserInfo: async (tokens, providerConfig) => {
            const res = await fetch(providerConfig.userInfoUrl!, {
                headers: { Authorization: `Bearer ${tokens.access_token}` },
            });
            if (!res.ok) throw new Error(`Acuity API Error (${res.status}): ${await res.text()}`);
            const data = await res.json();
            if (!data.email) throw new Error("Acuity user info did not return email.");
            return { email: data.email, name: data.firstName ? `${data.firstName} ${data.lastName || ''}`.trim() : data.email.split('@')[0] };
        },
    },
    calendly: {
        clientIdEnvVar: "CALENDLY_CLIENT_ID",
        clientSecretEnvVar: "CALENDLY_CLIENT_SECRET",
        tokenUrl: "https://auth.calendly.com/oauth/token",
        userInfoUrl: "https://api.calendly.com/users/me",
        getUserInfo: async (tokens, providerConfig) => {
            const res = await fetch(providerConfig.userInfoUrl!, {
                headers: { Authorization: `Bearer ${tokens.access_token}` },
            });
            if (!res.ok) throw new Error(`Calendly API Error (${res.status}): ${await res.text()}`);
            const data = await res.json();
            if (!data.resource?.email) throw new Error("Calendly user info did not return email.");
            if (!data.resource?.uri) throw new Error("Calendly user info did not return user URI.");
            if (!data.resource?.current_organization) throw new Error("Calendly user info did not return organization URI.");
            return { 
                email: data.resource.email, 
                name: data.resource.name, 
                id: data.resource.uri, // Using user URI as the primary 'id' for consistency
                calendly_user_uri: data.resource.uri, // Store explicitly
                calendly_organization_uri: data.resource.current_organization // Store explicitly
            };
        },
    },
    square: {
        clientIdEnvVar: "SQUARE_CLIENT_ID",
        clientSecretEnvVar: "SQUARE_CLIENT_SECRET",
        tokenUrl: "https://connect.squareup.com/oauth2/token", 
        getUserInfo: async (tokens, _providerConfig, functionRedirectUri, clientId, clientSecret, provider) => {
            if (!tokens.merchant_id) {
                 throw new Error("Square token response did not include merchant_id needed to fetch profile information.");
            }

            const squareApiVersion = "2024-04-17"; // Use a recent, fixed API version
            const merchantApiUrl = `https://connect.squareup.com/v2/merchants/${tokens.merchant_id}`; 

            const res = await fetch(merchantApiUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${tokens.access_token}`,
                    'Square-Version': squareApiVersion,
                    'Content-Type': 'application/json'
                }
            });

            if (!res.ok) {
                const errorText = await res.text();
                console.error(`[ERROR] (${FUNCTION_VERSION}) Failed to fetch Square merchant details for ${provider} (${tokens.merchant_id}): ${res.status} ${errorText}`);
                // Attempt to use a fallback if merchant details fetch fails, as token is already obtained.
                // The core functionality relies on the token, email is for display/logging.
                console.warn(`[WARN] (${FUNCTION_VERSION}) Using fallback email for Square merchant ${tokens.merchant_id} due to fetch error.`);
                return { email: `${tokens.merchant_id}@squareup.merchant`, id: tokens.merchant_id, name: "Square Merchant (Details Unavailable)" };
            }
            const merchantData = await res.json();

            const email = merchantData.merchant?.email || merchantData.merchant?.business_name?.replace(/\s+/g, '').toLowerCase() + `@${tokens.merchant_id}.squareup.com` || `${tokens.merchant_id}@squareup.merchant`;
            const name = merchantData.merchant?.business_name || "Square Merchant";

             if (!merchantData.merchant?.email) {
                console.warn(`[WARN] (${FUNCTION_VERSION}) Square merchant details for ${tokens.merchant_id} did not contain a direct email. Using generated fallback: ${email}`);
            }

            return { email, id: tokens.merchant_id, name };
        },
    },
};


function createSupabaseAdminClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error(`[FATAL] (${FUNCTION_VERSION}) Missing Supabase URL or Service Role Key env vars.`);
    throw new Error("Server configuration error: Missing Supabase credentials.");
  }
  return createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

const createRedirectResponse = (returnPath: string, params: Record<string, string> = {}, status = 302): Response => {
    const appBaseUrl = Deno.env.get("PUBLIC_APP_URL");
    if (!appBaseUrl) {
      console.error(`[FATAL] (${FUNCTION_VERSION}) PUBLIC_APP_URL env var not set.`);
      return new Response(JSON.stringify({ error: "Application base URL not configured." }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    const allowedPaths = ['/onboarding', '/dashboard/integrations', '/dashboard']; 
    let validatedPath = allowedPaths.includes(returnPath) ? returnPath : allowedPaths[0];
    console.log(`[DEBUG] (${FUNCTION_VERSION}) Final validated redirect path: ${validatedPath} (Original: ${returnPath || 'N/A'})`);
    try {
        const redirectUrl = new URL(validatedPath, appBaseUrl);
        Object.entries(params).forEach(([key, value]) => redirectUrl.searchParams.set(key, value));
        return new Response(null, { status: status, headers: { "Location": redirectUrl.toString(), ...corsHeaders } });
    } catch (e: any) {
        console.error(`[ERROR] (${FUNCTION_VERSION}) Failed to construct redirect URL: Base=${appBaseUrl}, Path=${validatedPath}`, e);
         return new Response(JSON.stringify({ error: "Failed to create redirect URL.", details: e.message }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
         });
    }
};

Deno.serve(async (req: Request) => {
  console.log(`--- [INFO] (${FUNCTION_VERSION}) Calendar Callback: ${req.method} ${req.url} ---`);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  let userIdFromState: string | null = null;
  let decodedReturnPath: string | null = '/onboarding';
  let providerFromState: CalendarProviderKey | null = null;

  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const errorParam = url.searchParams.get("error");

    if (errorParam) {
        if (state) { try { const d = JSON.parse(atob(state)); userIdFromState = d?.userId; decodedReturnPath = d?.returnPath || decodedReturnPath; providerFromState = d?.provider } catch (e) { /* ignore */ }}
        throw new Error(`OAuth provider error: ${decodeURIComponent(errorParam)}`);
    }
    if (!code || !state) throw new Error("Missing required code or state parameter.");

    let stateData: any;
    try { stateData = JSON.parse(atob(state)); } catch (e: any) { throw new Error(`State validation failed: ${e.message}`); }

    userIdFromState = stateData?.userId;
    providerFromState = stateData?.provider as CalendarProviderKey;
    const timestamp = stateData?.timestamp;
    const rawReturnPath = stateData?.returnPath;

    if (!userIdFromState || typeof userIdFromState !== 'string' ||
        !providerFromState || !PROVIDER_DETAILS[providerFromState] ||
        !timestamp || typeof timestamp !== 'number' ||
        !rawReturnPath || typeof rawReturnPath !== 'string' || !rawReturnPath.startsWith('/')) {
      throw new Error("State validation failed: Invalid content (userId, provider, timestamp, or returnPath).");
    }
    if (Date.now() - timestamp > 15 * 60 * 1000) throw new Error("State validation failed: Expired.");
    decodedReturnPath = rawReturnPath;

    console.log(`[INFO] (${FUNCTION_VERSION}) State validated for user: ${userIdFromState}, provider: ${providerFromState}, path: ${decodedReturnPath}`);

    const providerConfig = PROVIDER_DETAILS[providerFromState!];
    const clientId = Deno.env.get(providerConfig.clientIdEnvVar);
    const clientSecret = Deno.env.get(providerConfig.clientSecretEnvVar);
    const encryptionKey = Deno.env.get("CALENDAR_CREDENTIALS_ENCRYPTION_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");

    if (!clientId || !clientSecret || !encryptionKey || !supabaseUrl) {
      throw new Error("Server configuration error: Missing critical OAuth or encryption environment variables.");
    }
    const functionRedirectUri = `${supabaseUrl}/functions/v1/calendar-callback`;

    console.log(`[INFO] (${FUNCTION_VERSION}) Exchanging auth code for tokens (${providerFromState})...`);
    
    const tokenParams = new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: functionRedirectUri,
        client_id: clientId,
        client_secret: clientSecret,
    });

    const tokenResponse = await fetch(providerConfig.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenParams,
    });

    if (!tokenResponse.ok) {
        const errorBody = await tokenResponse.text();
        console.error(`[ERROR] (${FUNCTION_VERSION}) Failed to exchange code for ${providerFromState} for user ${userIdFromState}: ${tokenResponse.status} ${errorBody}`);
        throw new Error(`Failed to get ${providerFromState} tokens: ${tokenResponse.status} - ${errorBody}`);
    }
    const tokens = await tokenResponse.json();
    if (!tokens.access_token) throw new Error(`No access_token received from ${providerFromState}.`);
    console.log(`[INFO] (${FUNCTION_VERSION}) Tokens received for ${providerFromState} (Refresh token present: ${!!tokens.refresh_token})`);

    console.log(`[INFO] (${FUNCTION_VERSION}) Fetching user info (${providerFromState})...`);
    const userInfo: UserInfo = await providerConfig.getUserInfo(tokens, providerConfig, functionRedirectUri, clientId, clientSecret, providerFromState);
    if (!userInfo.email) throw new Error(`Failed to fetch user email from ${providerFromState}.`);
    console.log(`[INFO] (${FUNCTION_VERSION}) User info for ${providerFromState}: Email ${userInfo.email}`);

    // --- MODIFIED: Include Calendly URIs in credentials to encrypt ---
    const credentialsToEncrypt: any = {
      access_token: tokens.access_token,
      ...(tokens.refresh_token && { refresh_token: tokens.refresh_token }),
      ...(tokens.expires_in && { expiry_date: Date.now() + tokens.expires_in * 1000 }), 
      ...(tokens.expiry_date && !tokens.expires_in && { expiry_date: tokens.expiry_date }), 
      token_type: tokens.token_type,
      scope: tokens.scope, 
    };

    if (providerFromState === 'calendly') {
        if (!userInfo.calendly_user_uri || !userInfo.calendly_organization_uri) {
            console.error(`[ERROR] (${FUNCTION_VERSION}) Calendly user_uri or organization_uri missing from userInfo for user ${userIdFromState}`);
            throw new Error("Calendly user or organization URI missing after fetching user info. Cannot proceed with Calendly integration.");
        }
        credentialsToEncrypt.user_uri = userInfo.calendly_user_uri;
        credentialsToEncrypt.organization_uri = userInfo.calendly_organization_uri;
        console.log(`[INFO] (${FUNCTION_VERSION}) Adding Calendly URIs to credentials: user_uri: ${userInfo.calendly_user_uri}, organization_uri: ${userInfo.calendly_organization_uri}`);
    }
    // --- END MODIFIED ---

    const encryptedCredentials = await encrypt(JSON.stringify(credentialsToEncrypt), encryptionKey);

    const supabaseAdmin = createSupabaseAdminClient();
    const integrationData: any = {
        user_id: userIdFromState,
        provider: providerFromState,
        account_email: userInfo.email, // This is the primary email used for the integration row
        encrypted_credentials: encryptedCredentials,
        status: "active_watching", 
        last_synced_at: new Date().toISOString(),
        has_refresh_token: !!tokens.refresh_token,
        google_calendar_id: null,
        google_watch_channel_id: null,
        google_watch_resource_id: null,
        google_watch_expiration: null,
        last_webhook_at: null,
        last_sync_token: null,
        acuity_webhook_id: null, // Ensure these are nulled out for non-Acuity
        acuity_calendar_id: null,
        calendly_webhook_id: null, // Ensure this is nulled out for non-Calendly
        square_merchant_id: null, // Ensure this is nulled out for non-Square
    };

    if (providerFromState === "google") {
        integrationData.google_calendar_id = 'primary'; 
        integrationData.status = "active"; 
    } else if (providerFromState === "square") {
        integrationData.square_merchant_id = userInfo.id; // For Square, userInfo.id is merchant_id
    }
    // Note: calendly_webhook_id and acuity_webhook_id are set later after webhook registration
    
    console.log(`[INFO] (${FUNCTION_VERSION}) Upserting integration for ${providerFromState}, user ${userIdFromState}...`);
    const { data: upsertData, error: upsertError } = await supabaseAdmin
        .from("calendar_integrations")
        .upsert(integrationData, { onConflict: "user_id, provider", ignoreDuplicates: false }) // Should be user_id only due to single integration rule
        .select("id")
        .single();

    if (upsertError) throw new Error(`Database upsert error: ${upsertError.message}`);
    const integrationId = upsertData?.id;
    if (!integrationId) throw new Error("Failed to get integration ID after upsert.");
    console.log(`[INFO] (${FUNCTION_VERSION}) Integration ${integrationId} saved for ${providerFromState}.`);

    // Google-specific Watch Setup
    if (providerFromState === "google") {
      const oauth2Client = new googleapis.auth.OAuth2(clientId, clientSecret, functionRedirectUri);
      oauth2Client.setCredentials(tokens); 

      const webhookCallbackUrl = `${supabaseUrl}/functions/v1/google-calendar-webhook`;
      const watchChannelId = uuidv4();
      try {
        console.log(`[INFO] (${FUNCTION_VERSION}) Setting up Google Calendar watch (Channel: ${watchChannelId}) for integration ${integrationId}...`);
        const calendar = googleapis.calendar({ version: "v3", auth: oauth2Client });
        const watchResponse = await calendar.events.watch({
          calendarId: 'primary',
          requestBody: { id: watchChannelId, type: "web_hook", address: webhookCallbackUrl },
        });

        if (watchResponse.status === 200 && watchResponse.data.resourceId && watchResponse.data.expiration) {
          const watchResourceId = watchResponse.data.resourceId;
          const watchExpiration = new Date(parseInt(watchResponse.data.expiration, 10)).toISOString();
          console.log(`[SUCCESS] (${FUNCTION_VERSION}) Google watch setup OK for ${integrationId}. Resource: ${watchResourceId}, Expires: ${watchExpiration}`);
          await supabaseAdmin.from("calendar_integrations").update({
            google_watch_channel_id: watchChannelId,
            google_watch_resource_id: watchResourceId,
            google_watch_expiration: watchExpiration,
            status: "active_watching"
          }).eq("id", integrationId);
        } else {
          console.error(`[ERROR] (${FUNCTION_VERSION}) Google watch setup FAILED for ${integrationId}. Status: ${watchResponse.status}`, watchResponse.data);
          await supabaseAdmin.from("calendar_integrations").update({ status: "active_watch_failed" }).eq("id", integrationId);
        }
      } catch (watchError: any) {
        console.error(`[ERROR] (${FUNCTION_VERSION}) Exception during Google watch setup for ${integrationId}:`, watchError);
        await supabaseAdmin.from("calendar_integrations").update({ status: "active_watch_failed" }).eq("id", integrationId);
      }
    }else if (providerFromState === "acuity") {
      try {
        console.log(`[INFO] (${FUNCTION_VERSION}) Setting up Acuity webhooks for integration ${integrationId}...`);
    
        const webhookUrl = `${supabaseUrl}/functions/v1/acuity-calendar-webhook`;
        const eventTypes = [
          "appointment.scheduled",
          "appointment.rescheduled",
          "appointment.canceled"
        ];
    
        const WebhooksId: string[] = [];
    
        // Step 1: Register each webhook
        for (const eventType of eventTypes) {
          const response = await fetch("https://acuityscheduling.com/api/v1/webhooks", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${tokens.access_token}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              target: webhookUrl,
              event: eventType
            })
          });
    
          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Acuity webhook setup failed for event '${eventType}': ${response.status} ${errText}`);
          }
    
          const webhookData = await response.json();
          WebhooksId.push(webhookData.id);
    
          console.log(`[SUCCESS] (${FUNCTION_VERSION}) Acuity webhook registered for '${eventType}'. Webhook ID: ${webhookData.id}`);
        }
    
        // Step 2: Fetch calendarID(s) for this merchant
        const calendarRes = await fetch("https://acuityscheduling.com/api/v1/calendars", {
          method: "GET",
          headers: {
            Authorization: `Bearer ${tokens.access_token}`
          }
        });
    
        if (!calendarRes.ok) {
          const errText = await calendarRes.text();
          throw new Error(`Failed to fetch Acuity calendars: ${calendarRes.status} ${errText}`);
        }
    
        const calendars = await calendarRes.json();
        const calendarId = Array.isArray(calendars) && calendars.length > 0 ? calendars[0].id : null;
    
        if (!calendarId) {
          console.warn(`[WARN] (${FUNCTION_VERSION}) No calendar ID found for Acuity integration ${integrationId}.`);
        } else {
          console.log(`[INFO] (${FUNCTION_VERSION}) Acuity calendar ID resolved: ${calendarId}`);
        }
    
        // Step 3: Save webhook ID(s) and calendarID to Supabase
        await supabaseAdmin.from("calendar_integrations").update({
          status: "active_watching",
          acuity_webhook_id: WebhooksId.join(","),
          acuity_calendar_id: calendarId?.toString() ?? null
        }).eq("id", integrationId);
    
      } catch (err: any) {
        console.error(`[ERROR] (${FUNCTION_VERSION}) Failed to register Acuity webhook:`, err);
        await supabaseAdmin.from("calendar_integrations").update({
          status: "active_watch_failed",
          status_message: `Acuity webhook setup failed: ${err.message.substring(0,100)}`
        }).eq("id", integrationId);
      }
    } else if (providerFromState === "calendly") {
      try {
        console.log(`[INFO] (${FUNCTION_VERSION}) Setting up Calendly webhook for integration ${integrationId}...`);
    
        // User and Org URIs are already fetched in userInfo for Calendly
        const organizationUri = userInfo.calendly_organization_uri;
        const userUriForWebhook = userInfo.calendly_user_uri; // This is the user URI to use for webhook scope
    
        if (!organizationUri || !userUriForWebhook) {
          // This check is redundant due to earlier checks but good for safety
          throw new Error("Missing Calendly organization or user URI for webhook setup.");
        }
    
        const webhookUrl = `${supabaseUrl}/functions/v1/calendly-calendar-webhook`;
        const events = ["invitee.created", "invitee.canceled"]; // You can expand these events if needed
    
        const webhookRes = await fetch("https://api.calendly.com/webhook_subscriptions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            url: webhookUrl,
            events,
            organization: organizationUri,
            user: userUriForWebhook, // Use the user URI associated with the token
            scope: "user" // Or "organization" if you want webhooks for all users in org
          })
        });
    
        if (!webhookRes.ok) {
          const errText = await webhookRes.text();
          throw new Error(`Calendly webhook setup failed: ${webhookRes.status} ${errText}`);
        }
    
        const webhookData = await webhookRes.json();
        const webhookUri = webhookData.resource?.uri;

        let webhookId: string | null = null;
        if (webhookUri && typeof webhookUri === "string") {
          const parts = webhookUri.split("/");
          webhookId = parts[parts.length - 1]; 
        }

        if (!webhookId) {
          throw new Error("Failed to extract Calendly webhook ID from URI.");
        }

        console.log(`[SUCCESS] (${FUNCTION_VERSION}) Calendly webhook registered. Webhook ID: ${webhookId}`);
    
        await supabaseAdmin.from("calendar_integrations").update({
          status: "active_watching",
          calendly_webhook_id: webhookId
        }).eq("id", integrationId);
    
      } catch (err: any) {
        console.error(`[ERROR] (${FUNCTION_VERSION}) Failed to register Calendly webhook:`, err);
        await supabaseAdmin.from("calendar_integrations").update({
          status: "active_watch_failed",
          status_message: `Calendly webhook setup failed: ${err.message.substring(0,100)}`
        }).eq("id", integrationId);
      }
    } 
    // Square webhook setup is usually done via Square Developer Dashboard, not API during OAuth.
    // So, no specific API call here to create webhooks for Square.
    // The square_merchant_id was already set in integrationData.

    console.log(`[INFO] (${FUNCTION_VERSION}) Process complete for user ${userIdFromState}, provider ${providerFromState}. Redirecting...`);
    return createRedirectResponse(decodedReturnPath!, { success: "true", provider: providerFromState });

  } catch (error: any) {
    console.error(`--- [!!! ERROR IN (${FUNCTION_VERSION}) CALENDAR CALLBACK !!!] ---`);
    console.error(`User ID (from state): ${userIdFromState || 'Unknown'}`);
    console.error(`Provider (from state): ${providerFromState || 'Unknown'}`);
    console.error("Error Message:", error.message);
    if (error.stack) console.error("Stack Trace:", error.stack);
    const finalReturnPathOnError = (decodedReturnPath && decodedReturnPath.startsWith('/')) ? decodedReturnPath : '/onboarding';
    return createRedirectResponse(finalReturnPathOnError, { error: error.message || `Calendar connection failed for ${providerFromState || 'provider'}.` });
  }
});