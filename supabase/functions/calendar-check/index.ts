// supabase/functions/calendar-check/index.ts
import { corsHeaders } from "../_shared/cors.ts";

interface EnvVarCheck {
  providerKey: string;
  vars: string[];
}

const PROVIDER_ENV_VARS: EnvVarCheck[] = [
  {
    providerKey: "google",
    vars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  },
  {
    providerKey: "acuity",
    vars: ["ACUITY_CLIENT_ID", "ACUITY_CLIENT_SECRET"],
  },
  {
    providerKey: "calendly",
    vars: ["CALENDLY_CLIENT_ID", "CALENDLY_CLIENT_SECRET"],
  },
  {
    providerKey: "square",
    vars: ["SQUARE_CLIENT_ID", "SQUARE_CLIENT_SECRET"],
  },
];

// Common essential vars
const ESSENTIAL_ENV_VARS = [
  "CALENDAR_CREDENTIALS_ENCRYPTION_KEY",
  "SUPABASE_URL",
  "PUBLIC_APP_URL" // Needed for callbacks
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const missingEssentialVars = ESSENTIAL_ENV_VARS.filter(varName => !Deno.env.get(varName));

    if (missingEssentialVars.length > 0) {
      return new Response(JSON.stringify({
        error: `Critical server misconfiguration. Missing essential environment variables: ${missingEssentialVars.join(", ")}`,
        missingVars: missingEssentialVars,
        configuredProviders: [],
      }), {
        status: 500, // Internal Server Error for critical missing config
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const configuredProviders: string[] = [];
    const partiallyMissingProviderVars: string[] = [];

    PROVIDER_ENV_VARS.forEach(pCheck => {
      const missingForProvider = pCheck.vars.filter(v => !Deno.env.get(v));
      if (missingForProvider.length === 0) {
        configuredProviders.push(pCheck.providerKey);
      } else {
        partiallyMissingProviderVars.push(...missingForProvider.map(v => `${pCheck.providerKey} (${v})`));
      }
    });

    if (configuredProviders.length === 0) {
      return new Response(JSON.stringify({
        error: `No calendar providers are fully configured. Missing: ${partiallyMissingProviderVars.join(', ')}`,
        missingVars: partiallyMissingProviderVars,
        configuredProviders: [],
      }), {
        status: 400, // Bad Request as no provider can be used
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let message = "Backend ready.";
    if (partiallyMissingProviderVars.length > 0) {
      message = `Some providers are not configured: ${partiallyMissingProviderVars.join(', ')}. Available: ${configuredProviders.join(', ')}.`;
    }


    return new Response(JSON.stringify({
      status: "ready",
      message: message,
      configuredProviders: configuredProviders,
      missingVars: partiallyMissingProviderVars, // Include these for info even if some are configured
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[ERROR] Calendar Check failed:", error);
    return new Response(JSON.stringify({
      error: error.message,
      configuredProviders: [],
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
