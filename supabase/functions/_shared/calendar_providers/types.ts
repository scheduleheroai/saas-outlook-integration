// supabase/functions/_shared/calendar_providers/types.ts
import { z } from "npm:zod@3.22.4"; // --- CORRECTED ---
import type { CalendarIntegration, CalendarUserSettings, DecryptedCredentials } from "../calendar-helpers.ts";

// Common parameter schemas (subset of what edge functions parse)
// For check-calendar-availability
export const CheckAvailabilityParamsSchema = z.object({
    start_date_iso: z.string(),
    end_date_iso: z.string().optional(), // Will be calculated if not present
    duration_minutes: z.number().optional(),
    preferred_time_description: z.string().optional(),
    service_name: z.string().optional().nullable(),
});
export type CheckAvailabilityApiParams = z.infer<typeof CheckAvailabilityParamsSchema>;

// For create-calendar-event
export const CreateEventApiParamsSchema = z.object({
    summary: z.string(),
    description: z.string().optional().nullable(),
    startTimeIso: z.string(),
    endTimeIso: z.string(), // Will be calculated if not present based on duration
    customerName: z.string(),
    customerEmail: z.string().email().optional().nullable(),
    customerPhone: z.string().optional().nullable(),
    // service_name is used to build summary/description before calling provider
    sendNotifications: z.boolean().optional(), // Primarily for Google
});
export type CreateEventApiParams = z.infer<typeof CreateEventApiParamsSchema>;


// Common arguments for provider functions
export interface ProviderFunctionArgs<TParams> {
    apiParams: TParams;
    credentials: DecryptedCredentials;
    userSettings: CalendarUserSettings;
    integration: CalendarIntegration;
    userTimezone: string;
    userId: string;
    functionNameInPayload: string; // For logging context
    toolCallId: string;           // For logging context
}

// Result types
export interface AvailabilityResult {
    summary?: string;
    error?: string;
    // For specific error handling if needed, e.g., auth failure
    isAuthError?: boolean;
}

export interface EventCreationResult {
    message?: string;
    eventId?: string;
    additionalData?: Record<string, any>; // For provider-specific data like scheduling_url
    error?: string;
    isConflict?: boolean;   // e.g., HTTP 409
    isAuthError?: boolean;  // e.g., HTTP 401/403
}

// Interface for calendar provider modules
export interface CalendarProvider {
    checkAvailability: (args: ProviderFunctionArgs<CheckAvailabilityApiParams> & { effectiveEndDateIso: string }) => Promise<AvailabilityResult>;
    createEvent: (args: ProviderFunctionArgs<CreateEventApiParams>) => Promise<EventCreationResult>;
}

// Structure for busy slots, compatible with formatBusySlots function
export interface BusySlot {
    start: string; // ISO datetime string
    end: string;   // ISO datetime string
}