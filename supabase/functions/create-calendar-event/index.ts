// supabase/functions/create-calendar-event/index.ts
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

import { createGoogleEvent } from "../_shared/calendar_providers/google.ts";
import { createCalendlyEvent } from "../_shared/calendar_providers/calendly.ts";
import type { CreateEventApiParams, EventCreationResult } from "../_shared/calendar_providers/types.ts";


console.log("AI Tool: create-calendar-event function booting up (v6.2 - VAPI String Result Fix)."); // --- MODIFIED ---

const vapiParamsSchema = z.object({
    start_time_iso: z.string().datetime({ offset: true, message: "Start time must be in ISO 8601 format with timezone offset" }),
    end_time_iso: z.string().datetime({ offset: true, message: "End time must be in ISO 8601 format with timezone offset" }).optional(),
    summary: z.string().min(1, "Appointment summary cannot be empty."),
    customer_name: z.string().min(1, "Customer name is required."),
    customer_phone: z.string().optional().nullable(),
    customer_email: z.string().email("Invalid customer email format.").optional().nullable(),
    description: z.string().optional().nullable(),
    service_name: z.string().optional().nullable(),
});
type VapiFunctionParams = z.infer<typeof vapiParamsSchema>;

function getSupabaseAdmin(): SupabaseClient {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) { throw new Error("Server configuration error: Missing Supabase credentials."); }
    return createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

Deno.serve(async (req: Request) => {
    const startTimer = performance.now(); 
    if (req.method === "OPTIONS") { return new Response(null, { headers: corsHeaders }); }
    if (req.method !== "POST") { return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

    let userId: string | null = null;
    let vapiParsedParams: VapiFunctionParams;
    let userTimezone: string = 'UTC';
    let finalEndTimeIso: string;
    let toolCallId: string | null = null;
    let functionNameInPayload = "create-calendar-event";

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
            vapiParsedParams = vapiParamsSchema.parse(toolArguments);
        } catch (e: any) {
            console.error(`${functionNameInPayload}: User ${userId}: Invalid tool parameters (ToolCall ID: ${toolCallId}):`, toolArguments, "Error:", e);
            throw new Error(`Invalid tool parameters: ${e instanceof z.ZodError ? JSON.stringify(e.errors) : e.message}`);
        }
        console.log(`${functionNameInPayload}: User ${userId}: Parsed VAPI Params (ToolCall ID: ${toolCallId}):`, vapiParsedParams);

        const userSettings: CalendarUserSettings | null = await fetchUserSettingsForCalendar(userId);
        if (!userSettings) {
            console.error(`${functionNameInPayload}: User ${userId}: User settings not found (ToolCall ID: ${toolCallId}).`);
            throw new Error("User settings not found, cannot process calendar event.");
        }

        const integration: CalendarIntegration | null = await fetchActiveCalendarIntegration(userId);
        if (!integration) {
            console.error(`${functionNameInPayload}: User ${userId}: No active calendar integration found (ToolCall ID: ${toolCallId}).`);
            throw new Error("No active calendar integration found.");
        }

        userTimezone = getUserTimezone(userSettings);

        const now = new Date();
        const proposedStartTime = new Date(vapiParsedParams.start_time_iso);

        if (proposedStartTime < now) {
            const userNowInTheirTzStr = formatInTimeZone(now, userTimezone, 'yyyy-MM-dd HH:mm:ssXXX');
            const proposedStartTimeInTheirTzStr = formatInTimeZone(proposedStartTime, userTimezone, 'yyyy-MM-dd HH:mm:ssXXX');
            console.error(`${functionNameInPayload}: User ${userId}: Proposed start_time_iso ${vapiParsedParams.start_time_iso} (evaluates to ${proposedStartTimeInTheirTzStr} in ${userTimezone}) is in the past compared to current time ${userNowInTheirTzStr}. (ToolCall ID: ${toolCallId})`);
            throw new Error(`Cannot book an appointment in the past. The suggested start time '${proposedStartTimeInTheirTzStr}' is before the current time. Please suggest a future time.`);
        }

        if (vapiParsedParams.end_time_iso) {
            finalEndTimeIso = vapiParsedParams.end_time_iso;
            const proposedEndTime = new Date(vapiParsedParams.end_time_iso);
            if (proposedEndTime <= proposedStartTime) {
                 console.error(`${functionNameInPayload}: User ${userId}: Proposed end_time_iso ${vapiParsedParams.end_time_iso} is not after start_time_iso ${vapiParsedParams.start_time_iso}. (ToolCall ID: ${toolCallId})`);
                 throw new Error(`The appointment end time must be after the start time. Start: ${vapiParsedParams.start_time_iso}, End: ${vapiParsedParams.end_time_iso}`);
            }
            console.log(`${functionNameInPayload}: User ${userId}: Using provided end time: ${finalEndTimeIso} (ToolCall ID: ${toolCallId})`);
        } else {
            let durationMinutes: number | null = await getServiceDuration(userId, vapiParsedParams.service_name);
            if (!durationMinutes) {
                durationMinutes = userSettings?.default_appointment_duration_minutes ?? 60;
                console.warn(`${functionNameInPayload}: User ${userId}: Duration not determined from service or settings, using fallback: ${durationMinutes} mins (ToolCall ID: ${toolCallId}).`);
            } else {
                console.log(`${functionNameInPayload}: User ${userId}: Using duration ${durationMinutes} minutes for service "${vapiParsedParams.service_name || 'default'}" (ToolCall ID: ${toolCallId}).`);
            }
            const startDate = new Date(vapiParsedParams.start_time_iso);
            const endDate = new Date(startDate.getTime() + durationMinutes * 60000);
            finalEndTimeIso = endDate.toISOString();
            console.log(`${functionNameInPayload}: User ${userId}: Calculated end time: ${finalEndTimeIso} (ToolCall ID: ${toolCallId})`);
        }

        const credentials = await getValidCredentials(integration);
        if (!credentials) {
            console.error(`${functionNameInPayload}: User ${userId}: Failed to get valid calendar credentials (ToolCall ID: ${toolCallId}).`);
            throw new Error("Calendar connection requires reconnection or credentials invalid.");
        }

        const eventSummary = vapiParsedParams.service_name
            ? `${vapiParsedParams.service_name} - ${vapiParsedParams.customer_name}`
            : vapiParsedParams.summary;

        let eventDescription = vapiParsedParams.description || '';
        if (vapiParsedParams.customer_phone) eventDescription += `\nPhone: ${vapiParsedParams.customer_phone}`;
        if (vapiParsedParams.customer_email && !eventDescription.includes(vapiParsedParams.customer_email)) eventDescription += `\nEmail: ${vapiParsedParams.customer_email}`;
        if (vapiParsedParams.service_name) eventDescription += `\nService: ${vapiParsedParams.service_name}`;
        eventDescription = eventDescription.trim();

        const providerApiParams: CreateEventApiParams = {
            summary: eventSummary,
            description: eventDescription,
            startTimeIso: vapiParsedParams.start_time_iso,
            endTimeIso: finalEndTimeIso,
            customerName: vapiParsedParams.customer_name,
            customerEmail: vapiParsedParams.customer_email,
            customerPhone: vapiParsedParams.customer_phone,
            sendNotifications: !!vapiParsedParams.customer_email, 
        };

        let providerResult: EventCreationResult;
        const providerArgs = {
            apiParams: providerApiParams,
            credentials,
            userSettings, 
            integration,
            userTimezone,
            userId,
            functionNameInPayload,
            toolCallId
        };

        if (integration.provider === 'google') {
            providerResult = await createGoogleEvent(providerArgs);
        } else if (integration.provider === 'calendly') {
            providerResult = await createCalendlyEvent(providerArgs);
        } else {
            console.warn(`${functionNameInPayload}: User ${userId}: Event creation for provider "${integration.provider}" is not yet implemented (ToolCall ID: ${toolCallId}).`);
            throw new Error(`Event creation for calendar provider "${integration.provider}" is not yet supported.`);
        }

        if (providerResult.error) {
            if (providerResult.isConflict) throw new Error("Failed to create appointment: The requested time slot is no longer available. Please try another time.");
            if (providerResult.isAuthError) throw new Error("Calendar connection lost or permission denied. Please ask the user to reconnect their calendar.");
            throw new Error(providerResult.error);
        }
        if (!providerResult.message) {
            throw new Error("Confirmation message was not generated by the provider.");
        }
        
        // --- MODIFIED: 'result' is now the direct confirmation message string ---
        // For Calendly, providerResult.message already contains the scheduling link.
        // For Google, it's a success message.
        const resultPayload = providerResult.message;
        // --- END MODIFIED ---
        
        // Optionally, if you still want to log the full structured data before sending just the string:
        // console.log(`${functionNameInPayload}: User ${userId}: Structured provider result before sending string to VAPI (ToolCall ID: ${toolCallId}):`, providerResult);


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
        const isBadRequest = error.message.includes("Cannot book an appointment in the past") || error.message.includes("end time must be after the start time") || error.message.includes("requested time slot is no longer available");
        
        let httpStatus = 500;
        if (isAuthError) httpStatus = 401;
        else if (isBadRequest) httpStatus = 400; 
        if (error.message.includes("requested time slot is no longer available")) httpStatus = 409;

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