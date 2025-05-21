// /home/project/supabase/functions/_shared/vapiClient-business-qa.ts
// VAPI Client Helper Class
// Define interfaces for expected VAPI responses (optional but helpful)
export class VAPIClient {
  apiKey;
  baseUrl;
  // Define webhook URL directly or fetch from env var
  phoneNumberWebhookUrl = Deno.env.get('VAPI_PHONE_WEBHOOK_URL') || 'https://cddesenzusrcjoecvicv.supabase.co/functions/v1/vapi-webhook-handler';
  constructor(apiKey, baseUrl = 'https://api.vapi.ai'){
    if (!apiKey) throw new Error('VAPI API key is required.');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    if (!this.phoneNumberWebhookUrl) {
      console.warn("VAPI_PHONE_WEBHOOK_URL environment variable not set. Using default or potentially incorrect URL.");
    }
  }
  /**
   * Centralized function for making requests to the VAPI API.
   * Handles authentication, logging, and basic error handling.
   * @param endpoint - The API endpoint path (e.g., '/assistant').
   * @param options - Fetch options (method, headers, body).
   * @returns The parsed JSON response or text response from VAPI.
   */ async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const method = options.method || 'GET';
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      ...options.headers
    };
    // Determine Content-Type for logging if body exists
    if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json'; // Default to JSON if not FormData
    }
    // Log request details (redacting sensitive info like API key)
    const logBody = options.body instanceof FormData ? '[FormData]' // Don't log FormData content
     : options.body && typeof options.body === 'string' ? options.body.slice(0, 500) + (options.body.length > 500 ? '...' : '') // Log truncated JSON/text
     : '[Non-string Body]'; // Placeholder for other body types
    console.log(`VAPI → ${method} ${url}`, {
      headers: {
        ...headers,
        Authorization: 'Bearer [REDACTED]'
      },
      body: logBody
    });
    try {
      const response = await fetch(url, {
        ...options,
        headers
      });
      const contentType = response.headers.get('content-type') || '';
      const isJson = contentType.includes('application/json');
      let responseBody;
      // Handle different response types (No Content, JSON, Text)
      if (response.status === 204 || !contentType) {
        responseBody = null; // No content
      } else if (isJson) {
        responseBody = await response.json(); // Parse JSON
      } else {
        responseBody = await response.text(); // Get text for non-JSON
      }
      // Check for API errors (non-2xx status codes)
      if (!response.ok) {
        console.error(`VAPI API Error Response: ${response.status} ${response.statusText}`, responseBody);
        // Attempt to extract a meaningful error message from the response body
        const errorMessage = isJson && responseBody ? responseBody.error?.message || responseBody.message || JSON.stringify(responseBody) : typeof responseBody === 'string' ? responseBody : `HTTP ${response.status} Error`;
        // Create an error object with the status code
        const error = new Error(`VAPI API error (${response.status}): ${errorMessage}`); // Use 'any' to add status
        error.status = response.status;
        throw error;
      }
      // Optional: Log successful responses (can be very verbose)
      // console.log(`VAPI API Success (${response.status}):`, responseBody);
      return responseBody; // Return the parsed response body
    } catch (error) {
      console.error(`VAPI Request Failed: ${method} ${url}`, error);
      // Rethrow the error to be handled by the calling function
      if (error instanceof Error) {
        // Add status if it's missing but seems like an API error
        if (!error.status && error.message.startsWith('VAPI API error')) {
          try {
            error.status = parseInt(error.message.match(/\((\d+)\)/)?.[1] || '500');
          } catch (_) {}
        }
        throw error;
      }
      // Wrap non-Error exceptions
      throw new Error(`VAPI Request Failed: ${String(error)}`);
    }
  }
  // --- Assistant Methods ---
  async createAssistant(payload) {
    return this.request('/assistant', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }
  async updateAssistant(assistantId, payload) {
    if (!assistantId) throw new Error('Assistant ID is required for update.');
    return this.request(`/assistant/${assistantId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
  }
  async updateAssistantModel(assistantId, modelConfig) {
    if (!assistantId) throw new Error('Assistant ID is required for model update.');
    return this.request(`/assistant/${assistantId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        model: modelConfig
      })
    });
  }
  async getAssistant(assistantId) {
    if (!assistantId) throw new Error('Assistant ID is required.');
    return this.request(`/assistant/${assistantId}`, {
      method: 'GET'
    });
  }
  // --- Phone Number Methods ---
  /**
   * Provisions a new phone number using the 'vapi' provider and sets a server webhook URL.
   * @param assistantId - The ID of the assistant to associate with the number.
   * @param name - Optional name for the phone number (max 40 chars).
   * @param numberDesiredAreaCode - Optional 3-digit area code for the desired number.
   * @returns The provisioned phone number details from VAPI.
   */ async provisionPhoneNumber(assistantId, name, numberDesiredAreaCode) {
    if (!assistantId) throw new Error('Assistant ID is required for provisioning phone number.');
    const payload = {
      provider: 'vapi',
      assistantId: assistantId,
      server: {
        url: this.phoneNumberWebhookUrl
      }
    };
    if (name) payload.name = name.slice(0, 40); // Apply length constraint
    // Validate and add area code if provided
    if (numberDesiredAreaCode && /^\d{3}$/.test(numberDesiredAreaCode)) {
      payload.numberDesiredAreaCode = numberDesiredAreaCode;
    } else if (numberDesiredAreaCode) {
      console.warn(`Invalid numberDesiredAreaCode provided: ${numberDesiredAreaCode}. Must be 3 digits. Ignoring.`);
    }
    return this.request('/phone-number', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }
  async updatePhoneNumber(phoneNumberId, payload) {
    if (!phoneNumberId) throw new Error('Phone Number ID is required for update.');
    // Consider adding logic here to ensure 'server.url' isn't accidentally removed if required
    return this.request(`/phone-number/${phoneNumberId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
  }
  // --- Call Methods ---
  /**
   * Retrieves the details of a specific call by its ID.
   * @param callId - The unique identifier for the call.
   * @returns The call object details from VAPI.
   */ async getCall(callId) {
    if (!callId) throw new Error('Call ID is required.');
    return this.request(`/call/${callId}`, {
      method: 'GET'
    });
  }
  // --- File Methods ---
  /**
   * Uploads file content to VAPI.
   * @param fileContent - The content of the file (string or Blob).
   * @param fileName - The desired name for the file in VAPI.
   * @returns The VAPI file object containing the ID.
   */ async uploadFile(fileContent, fileName) {
    const formData = new FormData();
    // Create Blob if content is string, otherwise use provided Blob/File
    const blob = typeof fileContent === 'string' ? new Blob([
      fileContent
    ], {
      type: 'text/plain'
    }) // Assume text/plain for strings
     : fileContent;
    formData.append('file', blob, fileName);
    // Content-Type is set automatically by fetch for FormData
    return this.request('/file', {
      method: 'POST',
      body: formData,
      headers: {}
    });
  }
  /**
   * Deletes a file from VAPI by its ID.
   * @param fileId - The ID of the file to delete.
   * @returns VAPI confirmation (usually null or empty on success).
   */ async deleteFile(fileId) {
    if (!fileId) {
      console.warn("deleteFile called with empty or null fileId, skipping.");
      return null; // Don't attempt to delete if no ID
    }
    // DELETE requests typically don't have a body or specific Content-Type
    return this.request(`/file/${fileId}`, {
      method: 'DELETE',
      headers: {}
    });
  }
  // --- Tool Methods ---
  async createTool(payload) {
    return this.request('/tool', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }
  async updateTool(toolId, payload) {
    if (!toolId) throw new Error('Tool ID is required for update.');
    return this.request(`/tool/${toolId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
  }
  async getTool(toolId) {
    if (!toolId) throw new Error('Tool ID is required.');
    return this.request(`/tool/${toolId}`, {
      method: 'GET'
    });
  }
}
