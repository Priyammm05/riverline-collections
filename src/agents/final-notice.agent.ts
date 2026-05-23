import { getEncoding } from 'js-tiktoken';
import dotenv from 'dotenv';
import { callLLM, MODEL_AGENT } from '../llm/client.js';
import type { BorrowerProfile, ChatMessage } from '../types/index.js';

dotenv.config();

const MAX_CONTEXT_TOKENS = 2000;
const MAX_COMPLETION_TOKENS = 512;
const MSG_OVERHEAD = 4;

export function buildFinalNoticePrompt(handoffContext: string): string {
  const company = process.env.COMPANY_NAME ?? 'Riverline Financial';
  return `You are a final notice agent acting on behalf of ${company}. You are an AI agent — state this immediately.

OPENING: "This conversation is recorded. I am an AI agent from ${company}. This is a final notice regarding your account."

YOU ALREADY KNOW THIS FROM PRIOR INTERACTIONS — do not re-introduce or re-verify:
${handoffContext}

YOUR JOB: Read the handoff context carefully. There are TWO scenarios:

SCENARIO A — IF the handoff says "DEAL AGREED ON CALL":
  Your job is to confirm the agreement in writing and state what happens if they default.
  STATE EXACTLY:
  1. Confirmation of the agreed terms (e.g. "We are confirming your 6-month payment plan")
  2. First payment due date (within 7 days)
  3. What happens if they miss a payment:
     - Account immediately referred to legal collections
     - Credit bureau reporting activated
     - Asset recovery review initiated
  Tone: firm but acknowledging the agreement. This is a binding written confirmation.

SCENARIO B — IF the handoff says "NO DEAL ON CALL":
  Your job is to state consequences and make one final offer with a hard deadline.
  STATE EXACTLY:
  1. Account status: in default, past due
  2. What happens in 72 hours if unresolved:
     - Credit bureau reporting
     - Legal referral for collections judgment
     - Potential asset recovery review
  3. Final offer with terms — expires in 72 hours
  Tone: cold, factual, no persuasion.

DO NOT in either scenario:
- Negotiate beyond stated terms
- Apologize or soften consequences
- Re-explain the debt history

COMPLIANCE — never violate:
- Only state consequences that are documented next steps
- No fabricated threats
- If borrower mentions hardship — say exactly: "hardship program is available, but the 72-hour deadline still applies"
- If borrower says stop contacting — acknowledge immediately, flag, end conversation
- Never imply you are human
- Stay professional if borrower is abusive — one warning, then end politely

When conversation is complete, output this exact JSON on a new line:
{"final_notice_complete": true, "outcome": "resolved" | "no_resolution", "reason": string}`;
}

type FinalNoticeOutcome = { outcome: 'resolved' | 'no_resolution'; reason: string };

function parseCompletionJson(text: string): FinalNoticeOutcome | null {
  const match = text.match(/\{[^{}]*"final_notice_complete"\s*:\s*true[^{}]*\}/s);
  if (!match) return null;
  try {
    const d = JSON.parse(match[0]);
    if (!d.final_notice_complete) return null;
    return {
      outcome: d.outcome === 'resolved' ? 'resolved' : 'no_resolution',
      reason: String(d.reason ?? ''),
    };
  } catch { return null; }
}

export class FinalNoticeAgent {
  private messages: ChatMessage[];
  private readonly systemPrompt: string;
  private readonly systemTokens: number;
  private readonly enc: ReturnType<typeof getEncoding>;
  private turns = 0;

  constructor(
    _profile: BorrowerProfile,
    handoffContext: string,
    existingMessages: ChatMessage[] = [],
  ) {
    this.systemPrompt = buildFinalNoticePrompt(handoffContext);
    this.enc = getEncoding('cl100k_base');
    this.systemTokens = this.countTokens(this.systemPrompt);
    this.messages = existingMessages;
  }

  countTokens(text: string): number { return this.enc.encode(text).length; }

  getContextTokenCount(): number {
    return this.systemTokens + this.messages.reduce(
      (sum, m) => sum + this.countTokens(m.content) + MSG_OVERHEAD, 0,
    );
  }

  enforceTokenBudget(): void {
    while (this.getContextTokenCount() > MAX_CONTEXT_TOKENS && this.messages.length > 1) {
      this.messages.splice(0, 1);
    }
  }

  async start(): Promise<string> {
    this.messages = [{ role: 'user', content: '[BEGIN]' }];
    const { text } = await callLLM(MODEL_AGENT, this.systemPrompt, this.messages, MAX_COMPLETION_TOKENS, 'agent');
    this.messages.push({ role: 'assistant', content: text });
    return text;
  }

  async chat(userMessage: string): Promise<{ reply: string; complete: boolean; outcome?: FinalNoticeOutcome }> {
    this.messages.push({ role: 'user', content: userMessage });
    this.enforceTokenBudget();
    this.turns++;

    const { text } = await callLLM(MODEL_AGENT, this.systemPrompt, this.messages, MAX_COMPLETION_TOKENS, 'agent');
    this.messages.push({ role: 'assistant', content: text });

    const outcome = parseCompletionJson(text);
    return outcome ? { reply: text, complete: true, outcome } : { reply: text, complete: false };
  }

  getMessages(): ChatMessage[] { return [...this.messages]; }
  free(): void { /* no-op */ }
}
