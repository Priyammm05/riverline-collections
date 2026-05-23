import { getEncoding } from 'js-tiktoken';
import dotenv from 'dotenv';
import { callLLM, MODEL_AGENT } from '../llm/client.js';
import type { BorrowerProfile, AssessmentResult, ChatMessage } from '../types/index.js';

dotenv.config();

const MAX_CONTEXT_TOKENS = 2000;
const MAX_COMPLETION_TOKENS = 800;
const MSG_OVERHEAD = 4;

export function buildAssessmentPrompt(profile: BorrowerProfile): string {
  const company = process.env.COMPANY_NAME ?? 'Riverline Financial';
  return `You are a debt collections assessment agent acting on behalf of ${company}. You are an AI agent — disclose this immediately at the start of the conversation.

OPENING (say exactly this first):
"This conversation is being recorded. I am an AI agent contacting you on behalf of ${company} regarding account ending in ${profile.partialAccountNumber}."

YOUR ONLY JOB: Gather facts. Do not negotiate. Do not sympathize. Do not make offers.

VERIFICATION: Confirm their name and last 4 digits of account number. If they cannot verify, end the conversation.

GATHER ALL OF THE FOLLOWING before ending:
1. Can they confirm the debt amount of $${profile.debtAmount}?
2. Current monthly income (approximate)
3. Employment status
4. Any financial hardship (medical, job loss, other)?
5. Their stated position on repayment

COMPLIANCE RULES — never violate:
- Never display full account numbers
- Never threaten legal action (not your role)
- If they say "stop contacting me" — acknowledge and end immediately
- If they mention financial hardship or medical emergency — say: "I can connect you with our hardship assistance program"
- Never imply you are human
- Maintain professional tone regardless of borrower behavior

IMPORTANT: When you have gathered ALL of the above facts (identity, debt amount, income, employment, hardship, stated position), you MUST end your response by outputting EXACTLY this JSON on its own line — no other text after it:
{"assessment_complete": true, "identity_verified": bool, "debt_confirmed": bool, "monthly_income": number|null, "employment": string, "hardship": bool, "hardship_type": string|null, "emotional_state": string, "borrower_statement": string}`;
}

function parseCompletionJson(text: string, profile: BorrowerProfile): AssessmentResult | null {
  const match = text.match(/\{[^{}]*"assessment_complete"\s*:\s*true[^{}]*\}/s);
  if (!match) return null;
  try {
    const d = JSON.parse(match[0]);
    if (!d.assessment_complete) return null;
    const validEmotionalStates = ['calm', 'distressed', 'hostile', 'confused'] as const;
    const validHardshipTypes = ['medical', 'job_loss', 'other'] as const;
    return {
      identityVerified: Boolean(d.identity_verified),
      confirmedDebtAmount: d.debt_confirmed ? profile.debtAmount : 0,
      monthlyIncome: d.monthly_income ?? null,
      employmentStatus: String(d.employment ?? 'unknown'),
      hardshipDisclosed: Boolean(d.hardship),
      hardshipType: validHardshipTypes.includes(d.hardship_type) ? d.hardship_type : null,
      emotionalState: validEmotionalStates.includes(d.emotional_state) ? d.emotional_state : 'calm',
      borrowerStatement: String(d.borrower_statement ?? '').slice(0, 200),
      conversationTurns: 0,
    };
  } catch { return null; }
}

export class AssessmentAgent {
  private messages: ChatMessage[];
  private readonly systemPrompt: string;
  private readonly systemTokens: number;
  private readonly enc: ReturnType<typeof getEncoding>;
  private turns = 0;

  constructor(
    private readonly profile: BorrowerProfile,
    existingMessages: ChatMessage[] = [],
  ) {
    this.systemPrompt = buildAssessmentPrompt(profile);
    this.enc = getEncoding('cl100k_base');
    this.systemTokens = this.countTokens(this.systemPrompt);
    this.messages = existingMessages;
  }

  countTokens(text: string): number {
    return this.enc.encode(text).length;
  }

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

  async chat(userMessage: string): Promise<{ reply: string; complete: boolean; result?: AssessmentResult }> {
    this.messages.push({ role: 'user', content: userMessage });
    this.enforceTokenBudget();
    this.turns++;

    const { text } = await callLLM(MODEL_AGENT, this.systemPrompt, this.messages, MAX_COMPLETION_TOKENS, 'agent');
    this.messages.push({ role: 'assistant', content: text });

    const result = parseCompletionJson(text, this.profile);
    if (result) {
      result.conversationTurns = this.turns;
      return { reply: text, complete: true, result };
    }
    return { reply: text, complete: false };
  }

  getMessages(): ChatMessage[] { return [...this.messages]; }
  free(): void { /* no-op */ }
}
