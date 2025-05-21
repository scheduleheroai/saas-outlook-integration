// /home/project/supabase/functions/_shared/vapiClient-vapi-assistant-config.ts

export class VAPIClient {
  private apiKey: string;
  private baseUrl: string;
  // Define webhook URL directly or fetch from env var for phone numbers if needed by specific methods
  // Note: The main webhook for assistant events is configured in the assistant payload itself.
  // This phoneNumberWebhookUrl might be for other specific phone number event subscriptions if VAPI supports that.
  // For now, it's not directly used by the methods in this specific class for the current flow.
  public phoneNumberWebhookUrl = Deno.env.get('VAPI_PHONE_WEBHOOK_URL') || 'https://<YOUR_SUPABASE_PROJECT_REF>.supabase.co/functions/v1/vapi-webhook-handler';


  constructor(apiKey: string, baseUrl: string = 'https://api.vapi.ai') {
    if (!apiKey) {
      console.error("VAPIClient: API key is required.");
      throw new Error('VAPI API key is required.');
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
     if (!this.phoneNumberWebhookUrl.includes('supabase.co')) { // Basic check
      // console.warn("VAPIClient: VAPI_PHONE_WEBHOOK_URL might not be correctly set. Ensure it points to your handler if used for phone number specific webhooks.");
    }
  }

  private async request<T = any>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const method = options.method || 'GET';

    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${this.apiKey}`);

    if (!(options.body instanceof FormData) && method !== 'GET' && method !== 'HEAD') {
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
    }
    
    const logBody = options.body instanceof FormData ? '[FormData]'
     : options.body && typeof options.body === 'string' ? options.body.slice(0, 500) + (options.body.length > 500 ? '...' : '')
     : '[Non-string Body]';
    console.log(`VAPI → ${method} ${url}`, {
      headers: {
        ...Object.fromEntries(headers.entries()), // Convert Headers object to plain object for logging
        Authorization: 'Bearer [REDACTED]'
      },
      body: logBody
    });


    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      const contentType = response.headers.get('content-type');
      let responseBody: any;

      if (response.status === 204 || !contentType) { 
        return null as T;
      }

      if (contentType && contentType.includes('application/json')) {
        responseBody = await response.json();
      } else {
        responseBody = await response.text();
      }

      if (!response.ok) {
        const message = responseBody?.message || responseBody?.error?.message || (typeof responseBody === 'string' ? responseBody : `HTTP error ${response.status}`);
        console.error(`VAPIClient API Error: ${method} ${url} - Status ${response.status}`, message, responseBody);
        const error: Error & { status?: number; data?: any } = new Error( Array.isArray(message) ? message.join(', ') : String(message) );
        error.status = response.status;
        error.data = responseBody;
        throw error;
      }
      return responseBody as T;
    } catch (error) {
      if (!(error instanceof Error && 'status' in error)) {
          console.error(`VAPIClient Network/Request Failed: ${method} ${url}`, error);
      }
      throw error;
    }
  }

  // --- Assistant Methods ---
  async createAssistant(payload: Record<string, any>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('/assistant', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async updateAssistant(assistantId: string, payload: Record<string, any>): Promise<Record<string, any>> {
    if (!assistantId) throw new Error('Assistant ID is required for update.');
    return this.request<Record<string, any>>(`/assistant/${assistantId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  }

  async getAssistant(assistantId: string): Promise<Record<string, any>> {
    if (!assistantId) throw new Error('Assistant ID is required.');
    return this.request<Record<string, any>>(`/assistant/${assistantId}`);
  }
  
  async deleteAssistant(assistantId: string): Promise<null> {
    if (!assistantId) throw new Error('Assistant ID is required for deletion.');
    return this.request<null>(`/assistant/${assistantId}`, { method: 'DELETE' });
  }

  // --- Phone Number Methods ---
  async registerTwilioPhoneNumber(payload: {
    number: string;
    twilioAccountSid: string;
    twilioAuthToken: string; 
    assistantId?: string | null; // Allow null if assistant might not be ready
    name?: string;
    server?: { url: string; secret?: string }; // VAPI might require server URL for BYO Twilio
  }): Promise<{ id: string; [key: string]: any }> {
    const requestBody = { provider: "twilio", ...payload };
     if (requestBody.name && requestBody.name.length > 40) {
        requestBody.name = requestBody.name.slice(0, 40);
        console.warn(`VAPIClient: Truncated phone number name to 40 chars: ${requestBody.name}`);
    }
    // Ensure assistantId is not undefined, but null is acceptable if VAPI allows it
    if (requestBody.assistantId === undefined) requestBody.assistantId = null;

    return this.request<{ id: string }>('/phone-number', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
  }
  
  async provisionVapiPhoneNumber(payload: { // For VAPI managed numbers
    assistantId?: string | null;
    name?: string;
    numberDesiredAreaCode?: string;
    server?: { url: string; secret?: string };
  }): Promise<{ id: string; [key: string]: any }> {
    const requestBody = { provider: "vapi", ...payload };
    if (requestBody.name && requestBody.name.length > 40) {
      requestBody.name = requestBody.name.slice(0, 40);
    }
    if (requestBody.assistantId === undefined) requestBody.assistantId = null;
    return this.request<{ id: string }>('/phone-number', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
  }


  async updatePhoneNumber(phoneNumberId: string, payload: Record<string, any>): Promise<Record<string, any>> {
    if (!phoneNumberId) throw new Error('Phone Number ID is required for update.');
    return this.request<Record<string, any>>(`/phone-number/${phoneNumberId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  }

  async deletePhoneNumber(phoneNumberId: string): Promise<null> {
      if (!phoneNumberId) throw new Error('Phone Number ID is required for deletion.');
      return this.request<null>(`/phone-number/${phoneNumberId}`, { method: 'DELETE' });
  }

  // --- File Methods ---
  async uploadFile(fileContent: string | Blob, fileName: string): Promise<{ id: string; [key: string]: any }> {
    const formData = new FormData();
    if (typeof fileContent === 'string') {
      formData.append('file', new Blob([fileContent], { type: 'text/plain' }), fileName);
    } else {
      formData.append('file', fileContent, fileName);
    }
    return this.request<{ id: string }>('/file', {
      method: 'POST',
      body: formData,
    });
  }

  async deleteFile(fileId: string): Promise<null> {
    if (!fileId) {
      console.warn("VAPIClient: deleteFile called with empty fileId, skipping.");
      return null;
    }
    return this.request<null>(`/file/${fileId}`, { method: 'DELETE' });
  }

  // --- Tool Methods ---
  async createTool(payload: Record<string, any>): Promise<{ id: string; [key: string]: any }> {
    return this.request<{ id: string }>('/tool', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async updateTool(toolId: string, payload: Record<string, any>): Promise<Record<string, any>> {
    if (!toolId) throw new Error('Tool ID is required for update.');
    return this.request<Record<string, any>>(`/tool/${toolId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  }

  async getTool(toolId: string): Promise<Record<string, any> & { type?: string } > { // Added type to return
    if (!toolId) throw new Error('Tool ID is required.');
    return this.request<Record<string, any> & { type?: string } >(`/tool/${toolId}`);
  }

  async deleteTool(toolId: string): Promise<null> {
    if (!toolId) throw new Error('Tool ID is required for deletion.');
    return this.request<null>(`/tool/${toolId}`, { method: 'DELETE' });
  }
}