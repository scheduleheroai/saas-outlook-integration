// supabase/functions/_shared/calendar_providers/calendly.ts
import { format } from "npm:date-fns@3.6.0";
import { toZonedTime, formatInTimeZone } from "npm:date-fns-tz@3.1.3";
import type { ProviderFunctionArgs, AvailabilityResult, EventCreationResult, CheckAvailabilityApiParams, CreateEventApiParams, BusySlot } from "./types.ts";

const CALENDLY_API_BASE_URL = "https://api.calendly.com";
const TINYURL_API_BASE_URL = "https://api.tinyurl.com"; // TinyURL API base

interface CalendlyBusyTime {
    type: string;
    start_time: string; // ISO UTC string
    end_time: string;   // ISO UTC string
}

interface CalendlyUserBusyTimesResponse {
    collection: CalendlyBusyTime[];
}

interface CalendlyOneOffEventTypeLocation {
    kind: "custom" | "physical" | "google_conference" | "gotomeeting_conference" | "in_person_meeting" | "inbound_call" | "invitee_specified_location" | "microsoft_teams_conference" | "outbound_call" | "webex_conference" | "zoom_conference";
    location: string;
    additional_info?: string;
}

interface CalendlyOneOffEventTypePayload {
    name: string;
    host: string; // User URI
    duration: number; // minutes
    timezone: string;
    date_setting: {
        type: "date_range";
        start_date: string; // YYYY-MM-DD
        end_date: string;   // YYYY-MM-DD
    };
    location?: CalendlyOneOffEventTypeLocation;
}

interface CalendlyOneOffEventTypeResponse {
    resource: {
        uri: string;
        scheduling_url: string;
    };
}

// --- NEW: TinyURL specific interfaces ---
interface TinyUrlCreatePayload {
    url: string;
    domain?: string; // Optional, defaults to tinyurl.com
    // alias, tags, expires_at, description are also optional
}

interface TinyUrlCreateResponse {
    data: {
        tiny_url: string;
        url: string; // original long url
        // other fields
    };
    code: number;
    errors: string[];
}
// --- END NEW ---


// Helper to format Calendly's busy slots for the shared formatter
function formatCalendlyBusySlots(
    calendlyBusyTimes: CalendlyBusyTime[],
    startDateIso: string,
    endDateIso: string,
    timezone: string,
    formatBusySlotsFunction: (busySlots: BusySlot[], startDateIso: string, endDateIso: string, timezone: string) => string
): string {
    const mappedSlots: BusySlot[] = calendlyBusyTimes.map(slot => ({
        start: slot.start_time,
        end: slot.end_time,
    }));
    return formatBusySlotsFunction(mappedSlots, startDateIso, endDateIso, timezone);
}


export async function checkCalendlyAvailability(
    args: ProviderFunctionArgs<CheckAvailabilityApiParams> & {
        effectiveEndDateIso: string;
        formatBusySlotsFn: (busySlots: BusySlot[], startDateIso: string, endDateIso: string, timezone: string) => string;
    }
): Promise<AvailabilityResult> {
    const { apiParams, credentials, userTimezone, effectiveEndDateIso, userId, functionNameInPayload, toolCallId, formatBusySlotsFn } = args;

    if (!credentials.user_uri) {
        console.error(`${functionNameInPayload}: User ${userId}: Calendly user_uri not found in credentials (ToolCall ID: ${toolCallId}). This should be populated during OAuth.`);
        return { error: "Calendly configuration error: User URI missing. Please ask the user to reconnect their Calendly account.", isAuthError: true };
    }

    const startTimeUtc = new Date(apiParams.start_date_iso + "T00:00:00.000Z").toISOString();
    const endTimeUtc = new Date(effectiveEndDateIso + "T23:59:59.999Z").toISOString();

    const queryParams = new URLSearchParams({
        user: credentials.user_uri,
        start_time: startTimeUtc,
        end_time: endTimeUtc,
    });

    const url = `${CALENDLY_API_BASE_URL}/user_busy_times?${queryParams.toString()}`;
    console.log(`${functionNameInPayload}: User ${userId}: Querying Calendly User Busy Times. Range: ${apiParams.start_date_iso} to ${effectiveEndDateIso}. API URL: ${url} (ToolCall ID: ${toolCallId})`);

    try {
        const response = await fetch(url, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${credentials.access_token}`,
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`${functionNameInPayload}: User ${userId}: Calendly API error (${response.status}) during availability check (ToolCall ID: ${toolCallId}):`, errorBody);
            if (response.status === 401 || response.status === 403) {
                return { error: "Calendly connection lost or permission denied. Please ask the user to reconnect their calendar.", isAuthError: true };
            }
            return { error: `Failed to check Calendly availability: Calendly API responded with status ${response.status}` };
        }

        const data: CalendlyUserBusyTimesResponse = await response.json();
        const busySlots = data.collection || [];
        console.log(`${functionNameInPayload}: User ${userId}: Found ${busySlots.length} busy slots via Calendly (ToolCall ID: ${toolCallId}).`);

        const availabilitySummary = formatCalendlyBusySlots(busySlots, apiParams.start_date_iso, effectiveEndDateIso, userTimezone, formatBusySlotsFn);
        return { summary: availabilitySummary };

    } catch (error: any) {
        console.error(`${functionNameInPayload}: User ${userId}: Network or parsing error during Calendly availability check (ToolCall ID: ${toolCallId}):`, error.message, error.stack);
        return { error: `Failed to check Calendly availability: ${error.message}` };
    }
}

// --- MODIFIED: Function to shorten URL with TinyURL ---
async function shortenUrlWithTinyUrl(longUrl: string, apiKey: string, userId: string, functionName: string, toolCallId: string): Promise<string> {
    const payload: TinyUrlCreatePayload = {
        url: longUrl,
        domain: "tinyurl.com" // Using the default domain
    };

    console.log(`${functionName}: User ${userId}: Attempting to shorten URL with TinyURL (ToolCall ID: ${toolCallId}): ${longUrl}`);

    try {
        const response = await fetch(`${TINYURL_API_BASE_URL}/create`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            body: JSON.stringify(payload),
        });

        const responseBodyText = await response.text(); // Read body once for robust error handling

        if (!response.ok) {
            console.error(`${functionName}: User ${userId}: TinyURL API error (${response.status}) (ToolCall ID: ${toolCallId}). Body: ${responseBodyText}`);
            // Fallback to long URL if shortening fails
            return longUrl;
        }

        const data: TinyUrlCreateResponse = JSON.parse(responseBodyText);

        if (data.code === 0 && data.data?.tiny_url) {
            console.log(`${functionName}: User ${userId}: URL shortened successfully to ${data.data.tiny_url} (ToolCall ID: ${toolCallId})`);
            return data.data.tiny_url;
        } else {
            console.error(`${functionName}: User ${userId}: TinyURL response indicated failure or missing tiny_url. Code: ${data.code}, Errors: ${JSON.stringify(data.errors)} (ToolCall ID: ${toolCallId})`);
            return longUrl; // Fallback
        }
    } catch (error: any) {
        console.error(`${functionName}: User ${userId}: Exception during TinyURL call (ToolCall ID: ${toolCallId}):`, error.message, error.stack);
        return longUrl; // Fallback in case of network or other errors
    }
}
// --- END MODIFIED ---

export async function createCalendlyEvent(
    args: ProviderFunctionArgs<CreateEventApiParams>
): Promise<EventCreationResult> {
    const { apiParams, credentials, userTimezone, userId, functionNameInPayload, toolCallId } = args; 

    if (!credentials.user_uri) {
        console.error(`${functionNameInPayload}: User ${userId}: Calendly user_uri not found in credentials (ToolCall ID: ${toolCallId}). This should be populated during OAuth.`);
        return { error: "Calendly configuration error: User URI missing. Please ask the user to reconnect their Calendly account.", isAuthError: true };
    }

    const startDate = new Date(apiParams.startTimeIso);
    const endDate = new Date(apiParams.endTimeIso);
    const durationMinutes = Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60));

    if (durationMinutes <= 0) {
        return { error: "Calculated event duration is not positive." };
    }

    const eventDateStr = format(toZonedTime(apiParams.startTimeIso, userTimezone), 'yyyy-MM-dd');

    const payload: CalendlyOneOffEventTypePayload = {
        name: apiParams.summary,
        host: credentials.user_uri,
        duration: durationMinutes,
        timezone: userTimezone, 
        date_setting: {
            type: "date_range",
            start_date: eventDateStr,
            end_date: eventDateStr, 
        },
        location: {
            kind: "custom",
            location: `Appointment for ${apiParams.customerName}. Details via scheduling link.`,
        },
    };
    
    const url = `${CALENDLY_API_BASE_URL}/one_off_event_types`;
    console.log(`${functionNameInPayload}: User ${userId}: Creating Calendly One-Off Event Type for customer ${apiParams.customerName} (ToolCall ID: ${toolCallId}). Payload:`, JSON.stringify(payload));

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${credentials.access_token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`${functionNameInPayload}: User ${userId}: Calendly API error (${response.status}) during one-off event type creation (ToolCall ID: ${toolCallId}):`, errorBody);
            if (response.status === 401 || response.status === 403) {
                return { error: "Calendly connection lost or permission denied. Please ask the user to reconnect their calendar.", isAuthError: true };
            }
            return { error: `Failed to create Calendly scheduling link: Calendly API responded with status ${response.status}. Details: ${errorBody.substring(0,200)}` };
        }

        const calendlyData: CalendlyOneOffEventTypeResponse = await response.json();
        let finalSchedulingUrl = calendlyData.resource.scheduling_url;

        console.log(`${functionNameInPayload}: User ${userId}: Calendly One-Off Event Type created. Original URL: ${finalSchedulingUrl} (ToolCall ID: ${toolCallId})`);
        
        // --- MODIFIED: Shorten the URL ---
        const tinyUrlApiKey = Deno.env.get("TINYURL_API_KEY");
        if (tinyUrlApiKey && finalSchedulingUrl) {
            finalSchedulingUrl = await shortenUrlWithTinyUrl(finalSchedulingUrl, tinyUrlApiKey, userId, functionNameInPayload, toolCallId);
        } else if (!tinyUrlApiKey) {
            console.warn(`${functionNameInPayload}: User ${userId}: TINYURL_API_KEY not set. Using long Calendly URL. (ToolCall ID: ${toolCallId})`);
        }
        // --- END MODIFIED ---
        
        const startTimeInUserTz = toZonedTime(apiParams.startTimeIso, userTimezone);
        const startTimeLocal = formatInTimeZone(startTimeInUserTz, userTimezone, 'MMMM d, yyyy \'at\' h:mm a zzz');

        const confirmationMessage = `A Calendly scheduling link for '${apiParams.summary}' for ${startTimeLocal} has been prepared. Please use the following link to confirm and finalize your booking: ${finalSchedulingUrl}`;

        return {
            message: confirmationMessage,
            eventId: calendlyData.resource.uri, 
            additionalData: {
                scheduling_url: finalSchedulingUrl, // Return the (potentially shortened) URL
                original_scheduling_url: calendlyData.resource.scheduling_url, // Keep original for reference if needed
                customer_name: apiParams.customerName, 
                customer_email: apiParams.customerEmail,
            }
        };

    } catch (error: any) {
        console.error(`${functionNameInPayload}: User ${userId}: Network or parsing error during Calendly one-off event type creation (ToolCall ID: ${toolCallId}):`, error.message, error.stack);
        return { error: `Failed to create Calendly scheduling link: ${error.message}` };
    }
}