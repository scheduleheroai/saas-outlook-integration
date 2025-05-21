// supabase/functions/calendar-integration/index.ts
// Version: 2025-05-10_02 (Enforce single integration, check before OAuth)
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.39.7";
import { z } from "npm:zod@3.22.4";
import { corsHeaders } from "../_shared/cors.ts";

const FUNCTION_VERSION = "2025-05-10_02";

console.log(`[INFO] calendar-integration function booting. Version: ${FUNCTION_VERSION}`);

const supportedProviders = ["google", "acuity", "calendly", "square"] as const;
type CalendarProvider = (typeof supportedProviders)[number];


const postSchema = z.object({
  provider: z.enum(supportedProviders),
  returnPath: z.string().startsWith('/', "Return path must start with '/'").min(1),
});

const deleteSchema = z.object({
  integrationId: z.string().uuid()
});

function createSupabaseUserClient(req: Request): SupabaseClient {
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnonKey) {
      console.error(`[FATAL] (${FUNCTION_VERSION}) Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars in createSupabaseUserClient.`);
      throw new Error("Server configuration error: Supabase client cannot be initialized.");
  }
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

// Admin client for operations requiring service_role
function createSupabaseAdminClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error(`[FATAL] (${FUNCTION_VERSION}) Missing Supabase URL or Service Role Key env vars for admin client.`);
    throw new Error("Server configuration error: Missing Supabase admin credentials.");
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}


interface OAuthProviderConfig {
  authUrl: string;
  clientIdEnvVar: string;
  scopes: string[];
  extraParams?: Record<string, string>;
}

const OAUTH_CONFIGS: Record<CalendarProvider, OAuthProviderConfig> = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    clientIdEnvVar: "GOOGLE_CLIENT_ID",
    scopes: [
      "openid", "email",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.events",
    ],
    extraParams: { access_type: "offline", prompt: "consent" },
  },
  acuity: {
    authUrl: "https://acuityscheduling.com/oauth2/authorize",
    clientIdEnvVar: "ACUITY_CLIENT_ID",
    scopes: ["api-v1"],
  },
  calendly: {
    authUrl: "https://auth.calendly.com/oauth/authorize",
    clientIdEnvVar: "CALENDLY_CLIENT_ID",
    scopes: ["default"],
  },
  square: {
    authUrl: "https://connect.squareup.com/oauth2/authorize",
    clientIdEnvVar: "SQUARE_CLIENT_ID",
    scopes: [
      "APPOINTMENTS_READ",
      "APPOINTMENTS_WRITE",
      "MERCHANT_PROFILE_READ",
      "DEVELOPER_APPLICATION_WEBHOOKS_WRITE",
      "DEVELOPER_APPLICATION_WEBHOOKS_READ"
    ],
  },
};


Deno.serve(async (req: Request) => {
  console.log(`--- [INFO] (${FUNCTION_VERSION}) Request received: ${req.method} ${req.url} ---`);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let userSupabaseClient: SupabaseClient;
  try {
      userSupabaseClient = createSupabaseUserClient(req);
  } catch (e: any) { // Explicitly type e
      return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
  }

  const { data: { user }, error: authError } = await userSupabaseClient.auth.getUser();

  if (authError || !user) {
    console.warn(`[WARN] (${FUNCTION_VERSION}) Unauthorized access. AuthError: ${authError?.message}`);
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const userIdForLogs = user.id;
  console.log(`[INFO] (${FUNCTION_VERSION}) User authenticated: ${userIdForLogs}`);

  const adminSupabaseClient = createSupabaseAdminClient(); // For DB operations

  try {
    if (req.method === "POST") {
      console.log(`[INFO] (${FUNCTION_VERSION}) Handling POST for user ${userIdForLogs}`);
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      if (!supabaseUrl) {
        console.error(`[FATAL] (${FUNCTION_VERSION}) Missing SUPABASE_URL env var for user ${userIdForLogs}.`);
        throw new Error("Server configuration error: Missing Supabase URL.");
      }

      // Check for existing integration for this user BEFORE proceeding
      const { data: existingIntegrations, error: fetchError } = await adminSupabaseClient
        .from("calendar_integrations")
        .select("id, provider")
        .eq("user_id", userIdForLogs);

      if (fetchError) {
        console.error(`[ERROR] (${FUNCTION_VERSION}) DB error fetching existing integrations for user ${userIdForLogs}:`, fetchError);
        throw new Error("Failed to check existing integrations. Please try again.");
      }

      if (existingIntegrations && existingIntegrations.length > 0) {
        const currentProvider = existingIntegrations[0].provider;
        console.warn(`[WARN] (${FUNCTION_VERSION}) User ${userIdForLogs} already has an active integration with ${currentProvider}. Blocking new connection.`);
        return new Response(JSON.stringify({ error: `An integration with ${currentProvider} is already active. Please disconnect it first to connect a new provider.` }), {
          status: 409, // Conflict
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }


      let parsedBody;
      try {
        if (!req.headers.get('content-type')?.includes('application/json')) {
            throw new Error("Invalid Content-Type. Expected application/json.");
        }
        const rawBody = await req.json();
        parsedBody = postSchema.parse(rawBody);
        console.log(`[DEBUG] (${FUNCTION_VERSION}) Parsed request body for user ${userIdForLogs}:`, parsedBody);
      } catch (validationError: any) { // Explicitly type validationError
         console.error(`[ERROR] (${FUNCTION_VERSION}) Invalid request body for user ${userIdForLogs}:`, validationError);
         const errorMessage = validationError instanceof z.ZodError ? validationError.errors : validationError.message;
         return new Response(JSON.stringify({ error: "Invalid request body.", details: errorMessage }), {
           status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
         });
      }
      const { provider, returnPath } = parsedBody;
      const providerConfig = OAUTH_CONFIGS[provider];
      const clientId = Deno.env.get(providerConfig.clientIdEnvVar);

      if (!clientId) {
        console.error(`[FATAL] (${FUNCTION_VERSION}) Missing ${providerConfig.clientIdEnvVar} env var for ${provider} for user ${userIdForLogs}.`);
        throw new Error(`Server configuration error: OAuth Client ID for ${provider} is not set.`);
      }

      const redirectUri = `${supabaseUrl}/functions/v1/calendar-callback`;
      const statePayload = {
        userId: userIdForLogs,
        timestamp: Date.now(),
        returnPath: returnPath,
        provider: provider,
      };
      console.log(`[CRITICAL_DEBUG] (${FUNCTION_VERSION}) State payload BEFORE base64 encoding for user ${userIdForLogs}:`, JSON.stringify(statePayload));
      const state = btoa(JSON.stringify(statePayload));
      console.log(`[INFO] (${FUNCTION_VERSION}) Generated state param (first 20 chars): ${state.substring(0,20)}... for user ${userIdForLogs}, provider: ${provider}, returnPath: ${returnPath}`);

      const authUrl = new URL(providerConfig.authUrl);
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", providerConfig.scopes.join(" "));
      authUrl.searchParams.set("state", state);

      if (providerConfig.extraParams) {
        for (const key in providerConfig.extraParams) {
          authUrl.searchParams.set(key, providerConfig.extraParams[key]);
        }
      }
      
      console.log(`[INFO] (${FUNCTION_VERSION}) Redirecting user ${userIdForLogs} to ${provider} Auth URL (params): ${authUrl.search}`);
      return new Response(JSON.stringify({ url: authUrl.toString() }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (req.method === "GET") {
        console.log(`[INFO] (${FUNCTION_VERSION}) Handling GET for user ${userIdForLogs}`);
        // Use admin client to fetch for the specific user
        const { data: integrations, error: getError } = await adminSupabaseClient
            .from("calendar_integrations")
            .select("id, provider, account_email, status")
            .eq("user_id", userIdForLogs); // Ensure we only fetch for the authenticated user

        if (getError) {
            console.error(`[ERROR] (${FUNCTION_VERSION}) DB fetch error for user ${userIdForLogs}:`, getError);
            throw getError; // Let the main catch handle it
        }
        console.log(`[INFO] (${FUNCTION_VERSION}) Found ${integrations?.length || 0} integrations for user ${userIdForLogs}`);
        return new Response(JSON.stringify(integrations || []), {
            status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    if (req.method === "DELETE") {
      console.log(`[INFO] (${FUNCTION_VERSION}) Handling DELETE for user ${userIdForLogs}`);
      let integrationId;
      try {
        if (!req.headers.get('content-type')?.includes('application/json')) {
          throw new Error("Invalid Content-Type. Expected application/json.");
        }
        const body = await req.json();
        const parsedBody = deleteSchema.parse(body);
        integrationId = parsedBody.integrationId;
        console.log(`[INFO] (${FUNCTION_VERSION}) Attempting delete for integration ${integrationId}, user ${userIdForLogs}`);
      } catch (validationError: any) {
        console.error(`[ERROR] (${FUNCTION_VERSION}) Invalid delete body for user ${userIdForLogs}:`, validationError);
        const errorMessage = validationError instanceof z.ZodError ? validationError.errors : validationError.message;
        return new Response(JSON.stringify({ error: "Invalid request body.", details: errorMessage }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    
      // Fetch integration to get provider and webhook details
      const { data: integration, error: fetchError } = await adminSupabaseClient
        .from("calendar_integrations")
        .select("*")
        .eq("id", integrationId)
        .eq("user_id", userIdForLogs)
        .single();
    
      if (fetchError || !integration) {
        console.error(`[ERROR] (${FUNCTION_VERSION}) Failed to fetch integration ${integrationId} for deletion:`, fetchError);
        return new Response(JSON.stringify({ error: "Integration not found." }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    
      try {
        const encryptionKey = Deno.env.get("CALENDAR_CREDENTIALS_ENCRYPTION_KEY");
        if (!encryptionKey) throw new Error("Missing encryption key for credentials decryption.");
    
        // Decrypt credentials
        const deriveKey = async (keyString: string): Promise<CryptoKey> => {
          const keyMaterial = new TextEncoder().encode(keyString);
          const keyDigest = await crypto.subtle.digest('SHA-256', keyMaterial);
          return crypto.subtle.importKey('raw', keyDigest, { name: 'AES-GCM' }, false, ['decrypt']);
        };
    
        const decrypt = async (encrypted: string, keyString: string): Promise<any> => {
          const { iv, data } = JSON.parse(encrypted);
          const cryptoKey = await deriveKey(keyString);
          const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: Uint8Array.from(atob(iv), c => c.charCodeAt(0)) },
            cryptoKey,
            Uint8Array.from(atob(data), c => c.charCodeAt(0))
          );
          return JSON.parse(new TextDecoder().decode(decrypted));
        };
    
        const decryptedCreds = await decrypt(integration.encrypted_credentials, encryptionKey);
        const accessToken = decryptedCreds.access_token;
    
        const provider = integration.provider;
        if (provider === "google") {
          const { google } = await import("https://esm.sh/googleapis@137?target=deno");
          const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
          const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
          const supabaseUrl = Deno.env.get("SUPABASE_URL");
          const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, `${supabaseUrl}/functions/v1/calendar-callback`);
          oauth2Client.setCredentials({ access_token: accessToken });
          const calendar = google.calendar({ version: "v3", auth: oauth2Client });
    
          if (integration.google_watch_channel_id && integration.google_watch_resource_id) {
            try {
              await calendar.channels.stop({
                requestBody: {
                  id: integration.google_watch_channel_id,
                  resourceId: integration.google_watch_resource_id,
                }
              });
              console.log(`[INFO] (${FUNCTION_VERSION}) Google channel stopped: ${integration.google_watch_channel_id}`);
            } catch (err) {
              console.warn(`[WARN] (${FUNCTION_VERSION}) Failed to stop Google channel:`, err.message);
            }
          }
        } else if (provider === "acuity") {
            if (integration.acuity_webhook_id) {
            const webhookIds = integration.acuity_webhook_id.split(",");
            for (const webhookId of webhookIds) {
              try {
              await fetch(`https://acuityscheduling.com/api/v1/webhooks/${webhookId.trim()}`, {
                method: "DELETE",
                headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json"
                }
              });
              console.log(`[INFO] (${FUNCTION_VERSION}) Acuity webhook deleted: ${webhookId.trim()}`);
              } catch (err) {
              console.warn(`[WARN] (${FUNCTION_VERSION}) Failed to delete Acuity webhook: ${webhookId.trim()}`, err.message);
              }
            }
            }
        } else if (provider === "calendly") {
          if (integration.calendly_webhook_id) {
            try {
              await fetch(`https://api.calendly.com/webhook_subscriptions/${integration.calendly_webhook_id}`, {
                method: "DELETE",
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  "Content-Type": "application/json"
                }
              });
              console.log(`[INFO] (${FUNCTION_VERSION}) Calendly webhook deleted: ${integration.calendly_webhook_id}`);
            } catch (err) {
              console.warn(`[WARN] (${FUNCTION_VERSION}) Failed to delete Calendly webhook:`, err.message);
            }
          }
        }
    
      } catch (webhookCleanupError: any) {
        console.error(`[ERROR] (${FUNCTION_VERSION}) Webhook cleanup failed:`, webhookCleanupError.message);
        // Proceed with deletion anyway — don't block it
      }
    
      const { error: deleteError } = await adminSupabaseClient
        .from("calendar_integrations")
        .delete()
        .eq("id", integrationId)
        .eq("user_id", userIdForLogs);
    
      if (deleteError) {
        console.error(`[ERROR] (${FUNCTION_VERSION}) DB delete error for int ${integrationId}, user ${userIdForLogs}:`, deleteError);
        throw deleteError;
      }
    
      console.log(`[SUCCESS] (${FUNCTION_VERSION}) Deleted integration ${integrationId} for user ${userIdForLogs}`);
      return new Response(JSON.stringify({ success: true }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.warn(`[WARN] (${FUNCTION_VERSION}) Method not allowed: ${req.method} for user ${userIdForLogs}`);
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) { // Explicitly type error
    console.error(`[ERROR] (${FUNCTION_VERSION}) calendar-integration failed for user ${userIdForLogs || 'UNKNOWN'}:`, error);
    const statusCode = typeof error.status === 'number' ? error.status : 500; // Supabase errors might have status
    return new Response(JSON.stringify({ error: error.message || "An unexpected error occurred." }), {
      status: statusCode, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});