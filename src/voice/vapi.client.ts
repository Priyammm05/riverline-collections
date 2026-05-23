import dotenv from 'dotenv';

dotenv.config();

const VAPI_BASE = 'https://api.vapi.ai';

async function vapiRequest<T>(method: string, path: string, body?: unknown, usePublicKey = false): Promise<T> {
  const key = usePublicKey
    ? process.env.VAPI_PUBLIC_KEY ?? process.env.VAPI_API_KEY
    : process.env.VAPI_API_KEY;
  if (!key) throw new Error('VAPI_API_KEY is not set');

  const response = await fetch(`${VAPI_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Vapi API ${method} ${path} → ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

// Creates a Vapi assistant with the given system prompt.
// Returns the assistant ID. Call once and reuse the ID.
export async function createVapiAssistant(systemPrompt: string): Promise<string> {
  const company = process.env.COMPANY_NAME ?? 'Riverline Financial';
  const data = await vapiRequest<{ id: string }>('POST', '/assistant', {
    name: `${company} - Resolution Agent`,
    model: {
      provider: 'openai',
      model: 'gpt-4o-mini',                  // OpenAI — Vapi has credits for this on free accounts
      messages: [{ role: 'system', content: systemPrompt }],
      temperature: 0.3,
      maxTokens: 512,
    },
    voice: {
      provider: 'openai',
      voiceId: 'nova',  // OpenAI TTS — included in Vapi free tier, no API key needed
    },
    // End call if borrower says stop contacting
    endCallPhrases: ['stop contacting me', 'stop calling me', 'do not contact me'],
    recordingEnabled: true,
  });
  return data.id;
}

// Creates a Vapi call, injecting the handoff summary as the first message.
// workflowId is passed as metadata so the webhook can route the signal back.
// phoneNumberId + customerPhone are optional — omit for web/dashboard test calls.
export async function createVapiCall(opts: {
  assistantId: string;
  workflowId: string;
  handoffSummary: string;
  phoneNumberId?: string;
  customerPhone?: string;
}): Promise<string> {
  const company = process.env.COMPANY_NAME ?? 'Riverline Financial';
  const firstMessage =
    `This call is being recorded. I'm an AI agent from ${company}. ` +
    `I'm following up regarding your account. ` +
    `I have your information from our previous conversation.`;

  const body: Record<string, unknown> = {
    assistantId: opts.assistantId,
    assistantOverrides: { firstMessage },
    // Stored on the call object — webhook payload will include this
    metadata: { workflowId: opts.workflowId },
  };

  if (opts.phoneNumberId && opts.customerPhone) {
    body.phoneNumberId = opts.phoneNumberId;
    body.customer = { number: opts.customerPhone };
  }

  const data = await vapiRequest<{ id: string }>('POST', '/call', body);
  return data.id;
}

// Fetches the transcript for a completed call (fallback if webhook missed).
export async function getCallTranscript(callId: string): Promise<string> {
  const data = await vapiRequest<{ transcript?: string }>('GET', `/call/${callId}`);
  return data.transcript ?? '';
}

// Fetches the web call URL for dashboard testing (no phone number needed).
export async function createWebCall(opts: {
  assistantId: string;
  workflowId: string;
  handoffSummary: string;
}): Promise<{ callId: string; webCallUrl: string }> {
  // Web calls require the Public Key, not the Private Key
  // No firstMessage override — let the published assistant use its own opening.
  // JSON content in firstMessage overrides was silently breaking TTS.
  const data = await vapiRequest<{ id: string; webCallUrl?: string }>('POST', '/call/web', {
    assistantId: opts.assistantId,
    metadata: { workflowId: opts.workflowId },
  }, true); // true = use public key
  return { callId: data.id, webCallUrl: data.webCallUrl ?? '' };
}
