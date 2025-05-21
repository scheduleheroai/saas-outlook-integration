// supabase/functions/check-calendar-availability/index.ts
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.39.7";
import { corsHeaders } from "../_shared/cors.ts";
import { z } from "npm:zod@3.22.4";
import {
    fetchUserSettingsForCalendar,
    fetchActiveCalendarIntegration,
    getServiceDuration,
    getValidCredentials,
    getUserTimezone,
    CalendarUserSettings,
    DecryptedCredentials, 
    CalendarIntegration,  
} from "../_shared/calendar-helpers.ts";
import type { VapiToolCallPayload } from "../_shared/VapiPayload.ts";
import { formatInTimeZone } from "npm:date-fns-tz@3.1.3";

import { checkGoogleAvailability } from "../_shared/calendar_providers/google.ts";
import { checkCalendlyAvailability } from "../_shared/calendar_providers/calendly.ts";
import type { CheckAvailabilityApiParams, AvailabilityResult, BusySlot } from "../_shared/calendar_providers/types.ts";


console.log("AI Tool: check-calendar-availability function booting up (v7.2 - VAPI String Result Fix)."); // --- MODIFIED ---

const apiParamsSchema = z.object({
    start_date_iso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid start date format (YYYY-MM-DD required)"),
    end_date_iso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid end date format (YYYY-MM-DD required)").optional(),
    duration_minutes: z.number().int().positive("Duration must be a positive number of minutes.").optional(),
    preferred_time_description: z.string().optional(),
    service_name: z.string().optional().nullable(),
});

function getSupabaseAdmin(): SupabaseClient {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) { throw new Error("Server configuration error: Missing Supabase credentials."); }
    return createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

function formatBusySlotsForProvider(busySlots: BusySlot[], startDateIso: string, endDateIso: string, timezone: string): string {
    if (!busySlots || busySlots.length === 0) {
        return `The calendar appears to be generally open between ${startDateIso} and ${endDateIso}. To confirm a specific time, please suggest one.`;
    }
    const busySummary = busySlots.map(slot => {
        const startDt = slot.start ? new Date(slot.start) : null;
        const endDt = slot.end ? new Date(slot.end) : null;

        const start = startDt && !isNaN(startDt.getTime()) ? startDt.toLocaleTimeString([], { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true }) : 'Unknown start time';
        const end = endDt && !isNaN(endDt.getTime()) ? endDt.toLocaleTimeString([], { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true }) : 'Unknown end time';
        const day = startDt && !isNaN(startDt.getTime()) ? startDt.toLocaleDateString([], { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric' }) : 'Unknown date';
        return `${day} from ${start} to ${end}`;
    }).slice(0, 5);

    let message = `I found ${busySlots.length} busy period(s) between ${startDateIso} and ${endDateIso}. `;
    if (busySlots.length > 5) {
        message += `Some of these busy times are: ${busySummary.join('; ')}... and others. To find an open slot, please suggest a specific day or a narrower time range (e.g., 'next Monday morning', 'tomorrow around 3 PM').`;
    } else {
         message += `The busy times found are: ${busySummary.join('; ')}. Please suggest available times outside of these periods.`;
    }
    return message;
}

Deno.serve(async (req: Request) => {
    const startTimer = performance.now(); 
    if (req.method === "OPTIONS") { return new Response(null, { headers: corsHeaders }); }
    if (req.method !== "POST") { return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

    let userId: string | null = null;
    let parsedApiParams: CheckAvailabilityApiParams; 
    let userTimezone: string = 'UTC';
    let toolCallId: string | null = null;
    let functionNameInPayload = "check-calendar-availability"; 

    try {
        const payload: VapiToolCallPayload = await req.json();

        if (!payload.message || !payload.message.toolCallList || payload.message.toolCallList.length === 0) {
            console.error(`${functionNameInPayload}: VAPI Payload Error: Missing or empty toolCallList.`);
            return new Response(JSON.stringify({ error: "Invalid VAPI payload: toolCallList is missing or empty." }), {
                status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }
        const firstToolCall = payload.message.toolCallList[0];
        toolCallId = firstToolCall.id;
        
        if (!firstToolCall.function || typeof firstToolCall.function !== 'object') {
            console.error(`${functionNameInPayload}: VAPI Payload Error: 'function' object missing or invalid in toolCallList item (ToolCall ID: ${toolCallId}).`);
            throw new Error("Invalid VAPI payload: 'function' object missing or invalid in tool call.");
        }
        functionNameInPayload = firstToolCall.function.name || functionNameInPayload;


        if (!toolCallId) {
            console.error(`${functionNameInPayload}: VAPI Payload Error: toolCallId (id) missing in toolCallList item.`);
            return new Response(JSON.stringify({ error: "Invalid VAPI payload: toolCallId is missing." }), {
                status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        const assistantId = payload?.message?.call?.assistantId;
        if (!assistantId) {
            console.error(`${functionNameInPayload}: Assistant ID missing from VAPI payload (toolCallId: ${toolCallId}).`);
            throw new Error("User identification failed: Assistant ID missing.");
        }
        console.log(`${functionNameInPayload}: Tool called by Assistant ID: ${assistantId}, ToolCall ID: ${toolCallId}`);

        const supabaseAdmin = getSupabaseAdmin();
        const { data: userSettingsForId, error: userError } = await supabaseAdmin
            .from('user_settings')
            .select('user_id')
            .eq('vapi_assistant_id', assistantId)
            .single();

        if (userError) {
            console.error(`${functionNameInPayload}: User ${userId || assistantId}: Error fetching user_id for assistant_id ${assistantId}:`, userError);
            throw new Error("User identification failed: DB error looking up assistant.");
        }
        if (!userSettingsForId || !userSettingsForId.user_id) {
            console.error(`${functionNameInPayload}: User ${userId || assistantId}: No user_id found for assistant_id ${assistantId}.`);
            throw new Error("User identification failed: Assistant not linked to user.");
        }
        userId = userSettingsForId.user_id;
        console.log(`${functionNameInPayload}: Identified User ID: ${userId} for Assistant ID: ${assistantId}, ToolCall ID: ${toolCallId}`);

        const toolArguments = firstToolCall.function.arguments;
        if (toolArguments === undefined || toolArguments === null) {
            console.error(`${functionNameInPayload}: User ${userId}: Missing tool call arguments in payload's function object (ToolCall ID: ${toolCallId}).`);
            throw new Error("Missing tool call arguments.");
        }
        try {
            parsedApiParams = apiParamsSchema.parse(toolArguments) as CheckAvailabilityApiParams;
        } catch (e: any) {
            console.error(`${functionNameInPayload}: User ${userId}: Invalid tool parameters (ToolCall ID: ${toolCallId}):`, toolArguments, "Error:", e);
            throw new Error(`Invalid tool parameters: ${e instanceof z.ZodError ? JSON.stringify(e.errors) : e.message}`);
        }
        console.log(`${functionNameInPayload}: User ${userId}: Parsed Params (ToolCall ID: ${toolCallId}):`, parsedApiParams);

        const userSettings: CalendarUserSettings | null = await fetchUserSettingsForCalendar(userId);
        if (!userSettings) {
            console.error(`${functionNameInPayload}: User ${userId}: User settings not found (ToolCall ID: ${toolCallId}).`);
            throw new Error("User settings not found, cannot process availability check.");
        }

        const integration: CalendarIntegration | null = await fetchActiveCalendarIntegration(userId);
        if (!integration) {
            console.error(`${functionNameInPayload}: User ${userId}: No active calendar integration found (ToolCall ID: ${toolCallId}).`);
            throw new Error("No active calendar integration found.");
        }

        userTimezone = getUserTimezone(userSettings);
        console.log(`${functionNameInPayload}: User ${userId}: Using timezone ${userTimezone} (ToolCall ID: ${toolCallId}).`);

        const now = new Date();
        const userTodayDateString = formatInTimeZone(now, userTimezone, 'yyyy-MM-dd');

        if (parsedApiParams.start_date_iso < userTodayDateString) {
            console.warn(`${functionNameInPayload}: User ${userId}: LLM provided start_date_iso ${parsedApiParams.start_date_iso} is before user's current date ${userTodayDateString}. Adjusting to ${userTodayDateString} for availability check. (ToolCall ID: ${toolCallId})`);
            parsedApiParams.start_date_iso = userTodayDateString;
        }
        
        let durationMinutesParam = parsedApiParams.duration_minutes; 
        if (durationMinutesParam === undefined) { 
            durationMinutesParam = await getServiceDuration(userId, parsedApiParams.service_name);
            if (!durationMinutesParam) { 
                durationMinutesParam = userSettings.default_appointment_duration_minutes ?? 60;
                console.warn(`${functionNameInPayload}: User ${userId}: Duration not determined from service or explicit param, using user default: ${durationMinutesParam} mins (ToolCall ID: ${toolCallId}).`);
            } else {
                 console.log(`${functionNameInPayload}: User ${userId}: Duration determined from service_name "${parsedApiParams.service_name || 'default'}": ${durationMinutesParam} mins (ToolCall ID: ${toolCallId}).`);
            }
        } else {
            console.log(`${functionNameInPayload}: User ${userId}: Using explicitly provided duration: ${durationMinutesParam} mins (ToolCall ID: ${toolCallId}).`);
        }
        parsedApiParams.duration_minutes = durationMinutesParam;


        const credentials = await getValidCredentials(integration);
        if (!credentials) {
            console.error(`${functionNameInPayload}: User ${userId}: Failed to get valid calendar credentials (ToolCall ID: ${toolCallId}).`);
            throw new Error("Calendar connection requires reconnection or credentials invalid.");
        }

        let effectiveEndDateIso = parsedApiParams.end_date_iso;
        const startDateObj = new Date(parsedApiParams.start_date_iso + "T00:00:00Z"); 

        if (!effectiveEndDateIso) {
            const defaultDaysToAdd = integration.provider === 'calendly' ? 6 : 13; 
            const tempEndDateObj = new Date(startDateObj.getTime()); 
            tempEndDateObj.setUTCDate(tempEndDateObj.getUTCDate() + defaultDaysToAdd);
            effectiveEndDateIso = tempEndDateObj.toISOString().split('T')[0];
            console.log(`${functionNameInPayload}: User ${userId}: End date not provided for ${integration.provider}, defaulting to ${effectiveEndDateIso} (relative to start date ${parsedApiParams.start_date_iso}) (ToolCall ID: ${toolCallId}).`);
        } else if (effectiveEndDateIso < parsedApiParams.start_date_iso) {
            console.warn(`${functionNameInPayload}: User ${userId}: Provided end_date_iso ${effectiveEndDateIso} is before start_date_iso ${parsedApiParams.start_date_iso}. Adjusting end_date_iso to be same as start_date_iso for a single day check. (ToolCall ID: ${toolCallId})`);
            effectiveEndDateIso = parsedApiParams.start_date_iso;
        }

        if (integration.provider === 'calendly') {
            const maxEndDateObj = new Date(startDateObj.getTime());
            maxEndDateObj.setUTCDate(maxEndDateObj.getUTCDate() + 6);
            const maxEndDateIso = maxEndDateObj.toISOString().split('T')[0];
            if (effectiveEndDateIso > maxEndDateIso) {
                console.warn(`${functionNameInPayload}: User ${userId}: Requested end_date_iso ${effectiveEndDateIso} for Calendly exceeds 7-day limit. Capping to ${maxEndDateIso}. (ToolCall ID: ${toolCallId})`);
                effectiveEndDateIso = maxEndDateIso;
            }
        }
        
        parsedApiParams.end_date_iso = effectiveEndDateIso;


        let providerResult: AvailabilityResult;
        const providerArgs = {
            apiParams: parsedApiParams,
            credentials,
            userSettings,
            integration,
            userTimezone,
            effectiveEndDateIso, 
            userId,
            functionNameInPayload,
            toolCallId,
            formatBusySlotsFn: formatBusySlotsForProvider 
        };

        if (integration.provider === 'google') {
            providerResult = await checkGoogleAvailability(providerArgs);
        } else if (integration.provider === 'calendly') {
            providerResult = await checkCalendlyAvailability(providerArgs);
        } else {
            console.warn(`${functionNameInPayload}: User ${userId}: Availability check for provider "${integration.provider}" is not yet implemented (ToolCall ID: ${toolCallId}).`);
            throw new Error(`Availability check for calendar provider "${integration.provider}" is not yet supported.`);
        }

        if (providerResult.error) {
            if (providerResult.isAuthError) throw new Error(providerResult.error); 
            throw new Error(providerResult.error);
        }
        if (!providerResult.summary) {
             throw new Error("Availability summary was not generated by the provider.");
        }

        // --- MODIFIED: 'result' is now the direct summary string ---
        const resultPayload = providerResult.summary; 
        // --- END MODIFIED ---

        return new Response(
            JSON.stringify({
                results: [{ toolCallId: toolCallId, result: resultPayload }]
            }),
            {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
        );

    } catch (error: any) {
        console.error(`Error in ${functionNameInPayload} (ToolCall ID: ${toolCallId || 'N/A'}) for user ${userId || 'UNKNOWN_ASSISTANT_ID'}:`, error.message, error.stack);
        const isAuthError = error.message.includes("reconnect") || error.message.includes("credentials invalid") || error.message.includes("permission denied") || error.message.includes("User URI missing");
        const httpStatus = isAuthError ? 401 : 500;
        
        // --- MODIFIED: Error 'result' is also a direct string per VAPI docs ---
        const errorResultString = `Error: ${error.message || "An unexpected error occurred."}`;
        // --- END MODIFIED ---

        if (toolCallId) {
            return new Response(
                JSON.stringify({
                    results: [{
                        toolCallId: toolCallId,
                        result: errorResultString 
                    }]
                }),
                {
                    status: httpStatus,
                    headers: { ...corsHeaders, "Content-Type": "application/json" },
                }
            );
        }
        return new Response(JSON.stringify({ error: error.message || "An unexpected error occurred." }), {
            status: httpStatus,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    } finally {
        const duration = performance.now() - startTimer;
        console.log(`${functionNameInPayload} (ToolCall ID: ${toolCallId || 'N/A'}) execution time: ${duration.toFixed(2)} ms`);
    }
});