// supabase/functions/_shared/calendar_providers/google.ts
import { google as googleapis, calendar_v3 } from "https://esm.sh/googleapis@v134?target=deno";
import { formatInTimeZone, toZonedTime } from "npm:date-fns-tz@3.1.3";
import type { ProviderFunctionArgs, AvailabilityResult, EventCreationResult, CheckAvailabilityApiParams, CreateEventApiParams, BusySlot } from "./types.ts";

// Helper to format Google's busy slots for the shared formatter
function formatGoogleBusySlots(
    busySlots: calendar_v3.Schema$TimePeriod[],
    startDateIso: string,
    endDateIso: string,
    timezone: string,
    formatBusySlotsFunction: (busySlots: BusySlot[], startDateIso: string, endDateIso: string, timezone: string) => string
): string {
    const mappedSlots: BusySlot[] = busySlots.map(slot => ({
        start: slot.start!, // Google API ensures these are present in valid TimePeriod
        end: slot.end!,
    }));
    return formatBusySlotsFunction(mappedSlots, startDateIso, endDateIso, timezone);
}


export async function checkGoogleAvailability(
    args: ProviderFunctionArgs<CheckAvailabilityApiParams> & {
        effectiveEndDateIso: string;
        formatBusySlotsFn: (busySlots: BusySlot[], startDateIso: string, endDateIso: string, timezone: string) => string;
    }
): Promise<AvailabilityResult> {
    const { apiParams, credentials, integration, userTimezone, effectiveEndDateIso, userId, functionNameInPayload, toolCallId, formatBusySlotsFn } = args;

    const oauth2Client = new googleapis.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: credentials.access_token });
    const calendar = googleapis.calendar({ version: "v3", auth: oauth2Client });
    const calendarIdToQuery = integration.google_calendar_id || 'primary';

    const timeMin = new Date(apiParams.start_date_iso + "T00:00:00.000Z").toISOString();
    const timeMax = new Date(effectiveEndDateIso + "T23:59:59.999Z").toISOString();

    console.log(`${functionNameInPayload}: User ${userId}: Querying Google Free/Busy for calendar '${calendarIdToQuery}'. Range: ${apiParams.start_date_iso} to ${effectiveEndDateIso}. API Time Range: ${timeMin} to ${timeMax}. Timezone: ${userTimezone} (ToolCall ID: ${toolCallId})`);

    try {
        const freeBusyResponse = await calendar.freebusy.query({
            requestBody: {
                timeMin: timeMin,
                timeMax: timeMax,
                timeZone: userTimezone,
                items: [{ id: calendarIdToQuery }],
            },
        });
        const busySlotsCalendar = freeBusyResponse.data.calendars?.[calendarIdToQuery];
        const busySlots = busySlotsCalendar?.busy ?? [];
        console.log(`${functionNameInPayload}: User ${userId}: Found ${busySlots.length} busy slots via Google (ToolCall ID: ${toolCallId}).`);
        const availabilitySummary = formatGoogleBusySlots(busySlots, apiParams.start_date_iso, effectiveEndDateIso, userTimezone, formatBusySlotsFn);
        return { summary: availabilitySummary };
    } catch (apiError: any) {
        console.error(`${functionNameInPayload}: User ${userId}: Google Calendar API error during availability check (ToolCall ID: ${toolCallId}):`, apiError.response?.data || apiError.message, apiError.stack);
        if (apiError.code === 401 || apiError.code === 403) {
            return { error: "Calendar connection lost or permission denied. Please ask the user to reconnect their calendar.", isAuthError: true };
        }
        return { error: `Failed to check Google Calendar availability: ${apiError.message}` };
    }
}

export async function createGoogleEvent(
    args: ProviderFunctionArgs<CreateEventApiParams>
): Promise<EventCreationResult> {
    const { apiParams, credentials, integration, userTimezone, userId, functionNameInPayload, toolCallId } = args;

    const oauth2Client = new googleapis.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: credentials.access_token });
    const calendar = googleapis.calendar({ version: "v3", auth: oauth2Client });
    const calendarId = integration.google_calendar_id || 'primary';

    const event: calendar_v3.Schema$Event = {
        summary: apiParams.summary,
        description: apiParams.description || '', // Ensure description is not null
        start: { dateTime: apiParams.startTimeIso, timeZone: userTimezone },
        end: { dateTime: apiParams.endTimeIso, timeZone: userTimezone },
        attendees: [],
        reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 60 }, { method: 'popup', minutes: 15 }] },
    };

    if (apiParams.customerEmail && apiParams.customerName) { // Ensure both are present for attendee
        event.attendees?.push({ email: apiParams.customerEmail, displayName: apiParams.customerName });
    }

    console.log(`${functionNameInPayload}: User ${userId}: Creating Google Calendar event in ${calendarId} for customer ${apiParams.customerName} (ToolCall ID: ${toolCallId}). Start: ${apiParams.startTimeIso}, End: ${apiParams.endTimeIso}, TZ: ${userTimezone}`);
    try {
        const response = await calendar.events.insert({
            calendarId: calendarId,
            requestBody: event,
            sendNotifications: apiParams.sendNotifications, // Use passed param
        });
        const eventResultData = response.data;
        console.log(`${functionNameInPayload}: User ${userId}: Google Event created successfully. ID: ${eventResultData.id} (ToolCall ID: ${toolCallId})`);

        const startTimeInUserTz = toZonedTime(apiParams.startTimeIso, userTimezone);
        const startTimeLocal = formatInTimeZone(startTimeInUserTz, userTimezone, 'MMMM d, yyyy \'at\' h:mm a zzz');

        let confirmationMessage = `Success: Appointment '${apiParams.summary}' has been booked for ${startTimeLocal}.`;
        if (apiParams.sendNotifications && apiParams.customerEmail) {
            confirmationMessage += " An invitation has been sent to the customer.";
        }
        return { message: confirmationMessage, eventId: eventResultData.id! }; // id is non-null for successful insert
    } catch (apiError: any) {
        console.error(`${functionNameInPayload}: User ${userId}: Google Calendar API event insert error (ToolCall ID: ${toolCallId}):`, apiError.response?.data || apiError.message, apiError.stack);
        if (apiError.code === 409) {
            return { error: "Failed to create appointment: The requested time slot is no longer available. Please try another time.", isConflict: true };
        } else if (apiError.code === 401 || apiError.code === 403) {
            return { error: "Calendar connection lost or permission denied. Please ask the user to reconnect their calendar.", isAuthError: true };
        }
        return { error: `Failed to create appointment in Google Calendar: ${apiError.message}` };
    }
}