import { Context } from '@temporalio/activity';
import { v4 as uuidv4 } from 'uuid';
import { buildResolutionPrompt, PARSE_RESOLUTION_PROMPT } from '../../agents/resolution.agent.js';
import { createVapiAssistant, createVapiCall, createWebCall } from '../../voice/vapi.client.js';
import { summarize } from '../../summarizer/context-summarizer.js';
import { callLLM, MODEL_EVAL } from '../../llm/client.js';
import { db } from '../../db/db.js';
import type { BorrowerProfile, ResolutionResult, HandoffPayload } from '../../types/index.js';

// Use the published assistant ID from env — avoids creating duplicate unpublished assistants.
// Set VAPI_ASSISTANT_ID in .env to pin the published assistant.
async function getOrCreateAssistant(): Promise<string> {
  const pinned = process.env.VAPI_ASSISTANT_ID;
  if (pinned) return pinned;
  // Fallback: create a new one (will need to be published manually in Vapi dashboard)
  const prompt = buildResolutionPrompt();
  return createVapiAssistant(prompt);
}

// Stage 2a: Creates the Vapi call and stores callId in DB.
// Returns the Vapi callId so the workflow can reference it.
// The workflow then waits for the vapiCallEndedSignal before proceeding.
export async function createResolutionCallActivity(
  borrowerProfile: BorrowerProfile,
  handoff: HandoffPayload,
  workflowId: string,
): Promise<string> {
  Context.current().heartbeat('resolution-creating-call');

  const assistantId = await getOrCreateAssistant();
  const customerPhone = (borrowerProfile as BorrowerProfile & { phone?: string }).phone;

  let callId: string;
  let webCallUrl: string | undefined;

  if (customerPhone && process.env.VAPI_PHONE_NUMBER_ID) {
    // Outbound phone call
    callId = await createVapiCall({
      assistantId,
      workflowId,
      handoffSummary: handoff.content,
      phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
      customerPhone,
    });
  } else {
    // Web call — open the returned URL in a browser to join the call
    const result = await createWebCall({ assistantId, workflowId, handoffSummary: handoff.content });
    callId = result.callId;
    webCallUrl = result.webCallUrl;
  }

  // Store callId + webCallUrl so the API can surface it
  await db.query(
    `UPDATE borrower_workflows
     SET outcome = jsonb_set(jsonb_set(COALESCE(outcome, '{}'), '{vapiCallId}', $1::jsonb), '{webCallUrl}', $2::jsonb),
         updated_at = NOW()
     WHERE id = $3`,
    [JSON.stringify(callId), JSON.stringify(webCallUrl ?? ''), workflowId],
  );

  if (webCallUrl) {
    console.log(`\n🎙  VAPI WEB CALL READY — open this URL in Chrome to join:\n   ${webCallUrl}\n`);
  }

  Context.current().heartbeat(`resolution-call-created:${callId}`);
  return callId;
}

// Stage 2b: Parses the Vapi transcript into a structured ResolutionResult using Haiku.
export async function parseResolutionResultActivity(
  vapiTranscript: string,
  workflowId: string,
): Promise<ResolutionResult> {
  Context.current().heartbeat('resolution-parsing-transcript');

  const prompt = PARSE_RESOLUTION_PROMPT.replace('{transcript}', vapiTranscript);
  const { text: rawText } = await callLLM(
    MODEL_EVAL, '',
    [{ role: 'user', content: prompt }],
    256, 'summarization',
  );
  const text = rawText.trim();

  let parsed: Partial<ResolutionResult> = {};
  try {
    parsed = JSON.parse(text) as Partial<ResolutionResult>;
  } catch {
    // Malformed JSON — return safe defaults
  }

  const result: ResolutionResult = {
    offerPresented: parsed.offerPresented ?? 'payment_plan',
    offerTerms: parsed.offerTerms ?? '',
    borrowerResponse: parsed.borrowerResponse ?? 'no_response',
    objectionsRaised: parsed.objectionsRaised ?? [],
    callDurationSeconds: 0,       // Vapi doesn't surface this in the webhook body easily
    transcriptTokenCount: Math.ceil(vapiTranscript.length / 4),
  };

  // Persist transcript for audit trail
  await db.query(
    `INSERT INTO conversation_transcripts
       (id, workflow_id, agent_id, modality, transcript, token_count)
     VALUES ($1, $2, 'resolution', 'voice', $3, $4)`,
    [
      uuidv4(),
      workflowId,
      JSON.stringify([{ role: 'assistant', content: vapiTranscript }]),
      result.transcriptTokenCount,
    ],
  );

  return result;
}

// Stage 2c: Summarizes A1 + A2 transcripts into a ≤500-token handoff for A3.
export async function summarizeResolutionActivity(
  workflowId: string,
  vapiTranscript: string,
): Promise<HandoffPayload> {
  // Load A1 transcript from DB
  const a1Row = await db.query<{ transcript: { role: 'user' | 'assistant'; content: string }[] }>(
    `SELECT transcript FROM conversation_transcripts
     WHERE workflow_id = $1 AND agent_id = 'assessment'
     ORDER BY created_at DESC LIMIT 1`,
    [workflowId],
  );

  const a1Messages = a1Row.rows[0]?.transcript ?? [];

  // Append voice transcript as a single assistant message
  const combined = [
    ...a1Messages,
    { role: 'assistant' as const, content: `[Voice call transcript]\n${vapiTranscript}` },
  ];

  const handoff = await summarize(combined);

  await db.query(
    `INSERT INTO handoff_payloads
       (id, workflow_id, from_agent, to_agent, payload, token_count)
     VALUES ($1, $2, 'resolution', 'final_notice', $3, $4)`,
    [uuidv4(), workflowId, handoff.content, handoff.tokenCount],
  );

  return handoff;
}
