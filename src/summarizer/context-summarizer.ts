import { getEncoding } from 'js-tiktoken';
import dotenv from 'dotenv';
import { callLLM, MODEL_EVAL } from '../llm/client.js';
import type { ChatMessage, HandoffPayload } from '../types/index.js';

dotenv.config();

const MAX_HANDOFF_TOKENS = 500;
const enc = getEncoding('cl100k_base');

export function countTokens(text: string): number {
  return enc.encode(text).length;
}

function buildSummarizePrompt(transcript: string, strict: boolean): string {
  const charBudget = strict ? 200 : 400;
  return `Summarize this conversation into a structured handoff brief.
Output ONLY valid JSON. No preamble. No explanation.
Token budget: the JSON output must be under ${charBudget} characters when serialized.

Required fields:
{
  "identity_verified": boolean,
  "debt_amount": number,
  "monthly_income": number | null,
  "employment": string (max ${strict ? 10 : 20} chars),
  "hardship": boolean,
  "hardship_type": string | null (max ${strict ? 10 : 20} chars),
  "emotional_state": "calm"|"distressed"|"hostile"|"confused",
  "borrower_statement": string (max ${strict ? 50 : 100} chars),
  "offers_made": string[] (max 3 items, ${strict ? 20 : 30} chars each),
  "borrower_response": string (max ${strict ? 30 : 50} chars),
  "objections": string[] (max 3 items, ${strict ? 15 : 20} chars each)
}

Conversation to summarize:
${transcript}`;
}

function transcriptToString(messages: ChatMessage[]): string {
  return messages
    .filter((m) => !['[BEGIN]', '[BEGIN_CALL]'].includes(m.content))
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n');
}

function truncateFields(json: Record<string, unknown>): Record<string, unknown> {
  const out = { ...json };
  if (typeof out.employment === 'string') out.employment = out.employment.slice(0, 10);
  if (typeof out.hardship_type === 'string') out.hardship_type = out.hardship_type.slice(0, 10);
  if (typeof out.borrower_statement === 'string') out.borrower_statement = out.borrower_statement.slice(0, 40);
  if (typeof out.borrower_response === 'string') out.borrower_response = out.borrower_response.slice(0, 25);
  if (Array.isArray(out.offers_made))
    out.offers_made = (out.offers_made as string[]).slice(0, 2).map((s) => s.slice(0, 20));
  if (Array.isArray(out.objections))
    out.objections = (out.objections as string[]).slice(0, 2).map((s) => s.slice(0, 15));
  return out;
}

export async function summarize(messages: ChatMessage[]): Promise<HandoffPayload> {
  const transcript = transcriptToString(messages);

  // Attempt 1: normal limits
  const { text: attempt1 } = await callLLM(MODEL_EVAL, '', [{ role: 'user', content: buildSummarizePrompt(transcript, false) }], 400, 'summarization');
  if (countTokens(attempt1) <= MAX_HANDOFF_TOKENS) return { tokenCount: countTokens(attempt1), content: attempt1 };

  // Attempt 2: strict limits
  const { text: attempt2 } = await callLLM(MODEL_EVAL, '', [{ role: 'user', content: buildSummarizePrompt(transcript, true) }], 400, 'summarization');
  if (countTokens(attempt2) <= MAX_HANDOFF_TOKENS) return { tokenCount: countTokens(attempt2), content: attempt2 };

  // Attempt 3: forcibly truncate fields
  try {
    const parsed = JSON.parse(attempt2) as Record<string, unknown>;
    const content = JSON.stringify(truncateFields(parsed));
    const tokensFinal = countTokens(content);
    if (tokensFinal <= MAX_HANDOFF_TOKENS) return { tokenCount: tokensFinal, content };
  } catch { /* fall through */ }

  throw new Error(`Summarizer failed to produce a payload ≤${MAX_HANDOFF_TOKENS} tokens after 3 attempts.`);
}
