// File: supabase/functions/_shared/VapiPayload.ts
// Purpose: Defines the expected TypeScript interface for the VAPI payload
// when VAPI calls your tool's server URL. (Corrected based on actual payload)

export interface VapiToolCallPayload {
    message: {
        type?: "tool-calls";
        toolCallList?: Array<{
            id: string;
            type: "function"; // Typically "function" for tool calls
            function: {       // <<< CORRECTED: name and arguments are here
                name: string;
                arguments: any; // The arguments for the function
            };
        }>;
        // The 'toolCalls' field seems to be a duplicate or alternative, actual payload shows it.
        // If needed, it can be typed identically to toolCallList.
        // toolCalls?: Array<{
        //     id: string;
        //     type: "function";
        //     function: {
        //         name: string;
        //         arguments: any;
        //     };
        // }>;
        call?: {
            id?: string;
            assistantId?: string;
            orgId?: string;
        };
        assistant?: {
            id?: string;
            name?: string;
        };
        timestamp?: number;
    };
}