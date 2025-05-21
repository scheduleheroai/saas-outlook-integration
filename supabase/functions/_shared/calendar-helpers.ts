// supabase/functions/_shared/calendar-helpers.ts
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.39.7";
import { encode } from "https://deno.land/std@0.208.0/encoding/base64.ts";
import { google as googleapis } from "https://esm.sh/googleapis@v134?target=deno";

const FUNCTION_VERSION = "calendar-helpers-v1.3"; // --- MODIFIED --- (Version bump)

// Encryption helpers
async function deriveKey(keyString: string): Promise<CryptoKey> {
  const keyMaterial = new TextEncoder().encode(keyString);
  const keyDigest = await crypto.subtle.digest("SHA-256", keyMaterial);
  return crypto.subtle.importKey("raw", keyDigest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptCredentials(credentials: object, keyString: string): Promise<string> { // Made exportable if needed by OAuth callback
  const text = JSON.stringify(credentials);
  const cryptoKey = await deriveKey(keyString);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(text);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, encoded);
  return JSON.stringify({ iv: encode(iv), data: encode(new Uint8Array(encrypted)) });
}

async function decrypt(encryptedJsonString: string, keyString: string): Promise<any> {
  const { iv: encodedIv, data: encodedData } = JSON.parse(encryptedJsonString);
  const iv = Uint8Array.from(atob(encodedIv), c => c.charCodeAt(0));
  const data = Uint8Array.from(atob(encodedData), c => c.charCodeAt(0));
  const key = await deriveKey(keyString);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return JSON.parse(new TextDecoder().decode(decrypted));
}

// Supabase
function getSupabaseAdmin(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Missing Supabase credentials");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

// Types
export interface CalendarUserSettings {
  user_id: string;
  business_name?: string;
  ai_calling_hours?: { timezone?: string };
  default_appointment_duration_minutes?: number;
}

export interface CalendarIntegration {
  id: string;
  user_id: string;
  provider: 'google' | 'acuity' | 'calendly' | 'square';
  encrypted_credentials: any; // This will be a string after encryption
  account_email: string;
  google_calendar_id?: string;
  has_refresh_token?: boolean;
  status: string;
}

// --- MODIFIED: DecryptedCredentials explicitly includes user_uri and organization_uri ---
export interface DecryptedCredentials {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number; // Unix timestamp in milliseconds
  token_type?: string;
  scope?: string;
  // For Calendly: These should be fetched from /users/me after initial OAuth and stored.
  user_uri?: string;         // e.g., "https://api.calendly.com/users/AAAAAAAAAAAAAAAA"
  organization_uri?: string; // e.g., "https://api.calendly.com/organizations/BBBBBBBBBBBBBBBB"
}
// --- END MODIFIED ---

// User & Service Helpers
export async function fetchUserSettingsForCalendar(userId: string): Promise<CalendarUserSettings | null> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("user_settings").select("*").eq("user_id", userId).maybeSingle();
  if (error) {
    console.error(`[${FUNCTION_VERSION}] Error fetching user settings for ${userId}:`, error);
    return null;
  }
  return data ?? null;
}

export async function fetchActiveCalendarIntegration(userId: string): Promise<CalendarIntegration | null> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("calendar_integrations")
    .select("*")
    .eq("user_id", userId)
    .in("status", ["active", "active_watching", "active_watch_failed"]) 
    .maybeSingle();
   if (error) {
    console.error(`[${FUNCTION_VERSION}] Error fetching active calendar integration for ${userId}:`, error);
    return null;
  }
  return data ?? null;
}

export async function getServiceDuration(userId: string, serviceName?: string | null): Promise<number | null> {
  const sb = getSupabaseAdmin();
  if (serviceName) {
    const { data: serviceData, error: serviceError } = await sb.from("business_services")
      .select("duration_minutes")
      .eq("user_id", userId)
      .eq("service_name", serviceName)
      .maybeSingle();
    if (serviceError) console.error(`[${FUNCTION_VERSION}] Error fetching service duration for ${serviceName}:`, serviceError);
    if (serviceData?.duration_minutes) return serviceData.duration_minutes;
  }
  const { data: userSettingsData, error: userSettingsError } = await sb.from("user_settings")
    .select("default_appointment_duration_minutes")
    .eq("user_id", userId)
    .maybeSingle();
  if (userSettingsError) console.error(`[${FUNCTION_VERSION}] Error fetching default duration from user_settings:`, userSettingsError);
  return userSettingsData?.default_appointment_duration_minutes ?? null;
}

export function getUserTimezone(settings: CalendarUserSettings | null): string {
  const tz = settings?.ai_calling_hours?.timezone;
  try {
    if (tz) {
      new Intl.DateTimeFormat(undefined, { timeZone: tz });
      return tz;
    }
    return "UTC";
  } catch (e: any) {
    console.warn(`[${FUNCTION_VERSION}] Invalid timezone configured: ${tz}. Defaulting to UTC. Error: ${e.message}`);
    return "UTC";
  }
}

// Token Refresh + Credential Handling
export async function getValidCredentials(integration: CalendarIntegration): Promise<DecryptedCredentials | null> {
  const key = Deno.env.get("CALENDAR_CREDENTIALS_ENCRYPTION_KEY");
  if (!key) {
    console.error(`[${FUNCTION_VERSION}] CALENDAR_CREDENTIALS_ENCRYPTION_KEY is not set.`);
    throw new Error("Server configuration error: Missing encryption key.");
  }
  let creds: DecryptedCredentials;
  try {
    creds = await decrypt(integration.encrypted_credentials as string, key);
  } catch (e: any) {
    console.error(`[${FUNCTION_VERSION}] Failed to decrypt credentials for integration ${integration.id}:`, e.message);
    await updateIntegrationStatus(integration.id, 'reconnect_required_decryption_failure');
    return null;
  }
  
  const now = Date.now();
  const buffer = 5 * 60 * 1000; 

  if (creds.expiry_date && creds.expiry_date < (now + buffer)) {
    console.log(`[${FUNCTION_VERSION}] Token for ${integration.provider} (integration ID: ${integration.id}, user: ${integration.user_id}) is expired or nearing expiry. Attempting refresh.`);
    if (!creds.refresh_token) {
      console.warn(`[${FUNCTION_VERSION}] No refresh token available for ${integration.provider} (integration ID: ${integration.id}). Marking for reconnection.`);
      await updateIntegrationStatus(integration.id, 'reconnect_required_no_refresh_token');
      return null;
    }

    console.log(`[${FUNCTION_VERSION}] Refreshing token for ${integration.provider} integration ID ${integration.id}...`);
    let refreshedCreds: DecryptedCredentials | null = null;
    try {
        switch (integration.provider) {
        case "google":
            refreshedCreds = await refreshGoogleToken(integration, creds);
            break;
        case "acuity":
            refreshedCreds = await refreshAcuityToken(integration, creds);
            break;
        case "calendly":
            refreshedCreds = await refreshCalendlyToken(integration, creds);
            break;
        case "square":
            refreshedCreds = await refreshSquareToken(integration, creds);
            break;
        default:
            console.warn(`[${FUNCTION_VERSION}] Unsupported provider for refresh: ${integration.provider}`);
            return creds; 
        }
        if (refreshedCreds) {
            return refreshedCreds;
        } else {
            return null;
        }
    } catch (refreshError: any) {
        console.error(`[${FUNCTION_VERSION}] Error during token refresh for ${integration.provider} (integration ID: ${integration.id}):`, refreshError.message);
        await updateIntegrationStatus(integration.id, `reconnect_required_refresh_failed`);
        return null;
    }
  }
  return creds;
}

// --- MODIFIED: All refresh functions now accept `originalCreds` to preserve non-token fields ---
async function refreshGoogleToken(integration: CalendarIntegration, originalCreds: DecryptedCredentials): Promise<DecryptedCredentials | null> {
  const cid = Deno.env.get("GOOGLE_CLIENT_ID");
  const cs = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const uri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/calendar-callback`; 

  if (!cid || !cs) {
    console.error(`[${FUNCTION_VERSION}] Google client ID or secret not configured.`);
    await updateIntegrationStatus(integration.id, 'config_error_google_creds');
    return null;
  }

  const oauth = new googleapis.auth.OAuth2(cid, cs, uri);
  oauth.setCredentials({ refresh_token: originalCreds.refresh_token }); 
  
  try {
    const { credentials } = await oauth.refreshAccessToken();
    const newCreds: DecryptedCredentials = {
      ...originalCreds, 
      access_token: credentials.access_token!,
      refresh_token: credentials.refresh_token ?? originalCreds.refresh_token, 
      expiry_date: credentials.expiry_date ?? (Date.now() + 3500 * 1000), 
      token_type: credentials.token_type ?? originalCreds.token_type,
      scope: credentials.scope ?? originalCreds.scope,
    };
    await persistRefreshedToken(integration, newCreds);
    console.log(`[${FUNCTION_VERSION}] Successfully refreshed Google token for integration ID ${integration.id}`);
    return newCreds;
  } catch (error: any) {
    console.error(`[${FUNCTION_VERSION}] Google token refresh failed for integration ID ${integration.id}:`, error.message, error.response?.data);
    await updateIntegrationStatus(integration.id, 'reconnect_required_google_refresh_failed');
    return null;
  }
}

async function refreshAcuityToken(integration: CalendarIntegration, originalCreds: DecryptedCredentials): Promise<DecryptedCredentials | null> {
  const cid = Deno.env.get("ACUITY_CLIENT_ID");
  const cs = Deno.env.get("ACUITY_CLIENT_SECRET");
  if (!cid || !cs) {
    console.error(`[${FUNCTION_VERSION}] Acuity client ID or secret not configured.`);
    await updateIntegrationStatus(integration.id, 'config_error_acuity_creds');
    return null;
  }

  try {
    const res = await fetch("https://oauth.squarespace.com/api/1/login/oauth/provider/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: originalCreds.refresh_token!,
        client_id: cid,
        client_secret: cs,
        }),
    });

    if (!res.ok) {
        const errorBody = await res.text();
        console.error(`[${FUNCTION_VERSION}] Acuity token refresh failed for integration ID ${integration.id}. Status: ${res.status}, Body: ${errorBody}`);
        await updateIntegrationStatus(integration.id, 'reconnect_required_acuity_refresh_failed');
        return null;
    }
    const token = await res.json();
    const newCreds: DecryptedCredentials = {
        ...originalCreds,
        access_token: token.access_token,
        refresh_token: token.refresh_token ?? originalCreds.refresh_token,
        expiry_date: Date.now() + ((token.expires_in || 3600) * 1000),
        token_type: token.token_type,
        scope: token.scope,
    };
    await persistRefreshedToken(integration, newCreds);
    console.log(`[${FUNCTION_VERSION}] Successfully refreshed Acuity token for integration ID ${integration.id}`);
    return newCreds;
  } catch (error: any) {
    console.error(`[${FUNCTION_VERSION}] Exception during Acuity token refresh for integration ID ${integration.id}:`, error.message);
    await updateIntegrationStatus(integration.id, 'reconnect_required_acuity_exception');
    return null;
  }
}

async function refreshCalendlyToken(integration: CalendarIntegration, originalCreds: DecryptedCredentials): Promise<DecryptedCredentials | null> {
  const cid = Deno.env.get("CALENDLY_CLIENT_ID");
  const cs = Deno.env.get("CALENDLY_CLIENT_SECRET");
   if (!cid || !cs) {
    console.error(`[${FUNCTION_VERSION}] Calendly client ID or secret not configured.`);
    await updateIntegrationStatus(integration.id, 'config_error_calendly_creds');
    return null;
  }

  try {
    const res = await fetch("https://auth.calendly.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" }, 
        body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: originalCreds.refresh_token!,
        client_id: cid,
        client_secret: cs,
        }),
    });
    if (!res.ok) {
        const errorBody = await res.text();
        console.error(`[${FUNCTION_VERSION}] Calendly token refresh failed for integration ID ${integration.id}. Status: ${res.status}, Body: ${errorBody}`);
        await updateIntegrationStatus(integration.id, 'reconnect_required_calendly_refresh_failed');
        return null;
    }
    const token = await res.json();
    
    const newCreds: DecryptedCredentials = {
        ...originalCreds, // Preserve user_uri, organization_uri from original creds
        access_token: token.access_token,
        refresh_token: token.refresh_token ?? originalCreds.refresh_token,
        expiry_date: Date.now() + ((token.expires_in || 7200) * 1000), 
        token_type: token.token_type,
        scope: token.scope,
        // It's unlikely Calendly returns user_uri/organization_uri on refresh,
        // these are typically stable and obtained from /users/me after initial auth.
        // If their API changes, you might need to update these here from 'token' if provided.
        // user_uri: token.user_uri || originalCreds.user_uri,
        // organization_uri: token.organization_uri || originalCreds.organization_uri,
    };
    await persistRefreshedToken(integration, newCreds);
    console.log(`[${FUNCTION_VERSION}] Successfully refreshed Calendly token for integration ID ${integration.id}`);
    return newCreds;
  } catch (error: any) {
    console.error(`[${FUNCTION_VERSION}] Exception during Calendly token refresh for integration ID ${integration.id}:`, error.message);
    await updateIntegrationStatus(integration.id, 'reconnect_required_calendly_exception');
    return null;
  }
}

async function refreshSquareToken(integration: CalendarIntegration, originalCreds: DecryptedCredentials): Promise<DecryptedCredentials | null> {
  const cid = Deno.env.get("SQUARE_CLIENT_ID");
  const cs = Deno.env.get("SQUARE_CLIENT_SECRET");
  if (!cid || !cs) {
    console.error(`[${FUNCTION_VERSION}] Square client ID or secret not configured.`);
    await updateIntegrationStatus(integration.id, 'config_error_square_creds');
    return null;
  }

  try {
    const res = await fetch("https://connect.squareup.com/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: cid,
        client_secret: cs,
        refresh_token: originalCreds.refresh_token!,
        }),
    });

    if (!res.ok) {
        const errorBody = await res.text();
        console.error(`[${FUNCTION_VERSION}] Square token refresh failed for integration ID ${integration.id}. Status: ${res.status}, Body: ${errorBody}`);
        await updateIntegrationStatus(integration.id, 'reconnect_required_square_refresh_failed');
        return null;
    }
    const token = await res.json();
    const newCreds: DecryptedCredentials = {
        ...originalCreds,
        access_token: token.access_token,
        refresh_token: token.refresh_token ?? originalCreds.refresh_token,
        expiry_date: Date.now() + ((token.expires_in || 3600) * 1000), 
        token_type: token.token_type,
        scope: token.scope,
    };
    await persistRefreshedToken(integration, newCreds);
    console.log(`[${FUNCTION_VERSION}] Successfully refreshed Square token for integration ID ${integration.id}`);
    return newCreds;
  } catch (error: any) {
    console.error(`[${FUNCTION_VERSION}] Exception during Square token refresh for integration ID ${integration.id}:`, error.message);
    await updateIntegrationStatus(integration.id, 'reconnect_required_square_exception');
    return null;
  }
}
// --- END MODIFIED REFRESH FUNCTIONS ---

// Shared update logic
async function persistRefreshedToken(integration: CalendarIntegration, creds: DecryptedCredentials) {
  const key = Deno.env.get("CALENDAR_CREDENTIALS_ENCRYPTION_KEY");
  if (!key) {
    console.error(`[${FUNCTION_VERSION}] CALENDAR_CREDENTIALS_ENCRYPTION_KEY is not set. Cannot persist token.`);
    return;
  }
  const encrypted = await encryptCredentials(creds, key);
  const sb = getSupabaseAdmin();
  const { error } = await sb.from("calendar_integrations").update({
    encrypted_credentials: encrypted,
    has_refresh_token: !!creds.refresh_token,
    status: integration.status.startsWith('reconnect_required') ? 'active' : integration.status,
    updated_at: new Date().toISOString(),
  }).eq("id", integration.id);

  if (error) {
    console.error(`[${FUNCTION_VERSION}] Failed to persist refreshed token for integration ID ${integration.id}:`, error);
  } else {
    console.log(`[${FUNCTION_VERSION}] Successfully persisted refreshed token for integration ID ${integration.id}. New expiry: ${creds.expiry_date ? new Date(creds.expiry_date).toISOString() : 'N/A'}`);
  }
}

async function updateIntegrationStatus(id: string, status: string) {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from("calendar_integrations").update({
    status,
    updated_at: new Date().toISOString(),
  }).eq("id", id);
  if (error) {
    console.error(`[${FUNCTION_VERSION}] Failed to update integration status to ${status} for ID ${id}:`, error);
  } else {
    console.log(`[${FUNCTION_VERSION}] Updated integration status to ${status} for ID ${id}`);
  }
}

console.log(`[${FUNCTION_VERSION}] Calendar helpers ready.`);