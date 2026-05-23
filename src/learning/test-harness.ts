import { getEncoding } from 'js-tiktoken';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import { callLLM, MODEL_AGENT, MODEL_EVAL } from '../llm/client.js';
import type { AgentId, BorrowerPersona, BorrowerProfile, ChatMessage } from '../types/index.js';

dotenv.config();

const MAX_TURNS = 12;
const MAX_CONTEXT_TOKENS = 2000;
const MSG_OVERHEAD = 4;
const enc = getEncoding('cl100k_base');

function countTokens(text: string): number { return enc.encode(text).length; }

export const EVAL_BORROWER_PROFILES: BorrowerProfile[] = [
  { borrowerId: 'eval-001', name: 'John Smith',   partialAccountNumber: '4321', debtAmount: 12000, loanType: 'personal' },
  { borrowerId: 'eval-002', name: 'Maria Garcia', partialAccountNumber: '8765', debtAmount: 8500,  loanType: 'auto'     },
  { borrowerId: 'eval-003', name: 'James Wilson', partialAccountNumber: '2233', debtAmount: 22000, loanType: 'medical'  },
];

const PERSONA_PROMPTS: Record<BorrowerPersona, string> = {
  cooperative: `You are a borrower who defaulted on a loan. You are cooperative and honest.
- Confirm your identity when asked; acknowledge the debt is correct
- Mention you lost your job 3 months ago (hardship)
- Willing to discuss payment but can't afford the full amount
- Respond in 1-3 sentences. Be realistic, not overly eager.`,

  combative: `You are a borrower who defaulted on a loan. You are hostile and uncooperative.
- Question the legitimacy of the debt; threaten to report to CFPB
- Use aggressive language (no profanity); refuse to confirm income or employment
- After 4-5 turns you may soften slightly if the agent stays professional
- Respond in 1-3 sentences. Stay in character.`,

  distressed: `You are a borrower who defaulted on a loan. You are emotionally distressed.
- Mention a medical emergency caused the default; become emotional when discussing money
- Repeatedly ask about assistance programs; cooperative but overwhelmed
- Respond in 1-3 sentences. Show genuine distress without melodrama.`,
};

export class SeededRandom {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0; }
  next(): number { this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0; return this.state / 4294967296; }
  pick<T>(arr: T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
}

function trimMessages(messages: ChatMessage[], systemTokens: number): ChatMessage[] {
  const msgs = [...messages];
  while (msgs.length > 1) {
    const total = systemTokens + msgs.reduce((s, m) => s + countTokens(m.content) + MSG_OVERHEAD, 0);
    if (total <= MAX_CONTEXT_TOKENS) break;
    msgs.splice(0, 1);
  }
  return msgs;
}

async function agentTurn(systemPrompt: string, messages: ChatMessage[]): Promise<string> {
  const trimmed = trimMessages(messages, countTokens(systemPrompt));
  const { text } = await callLLM(MODEL_AGENT, systemPrompt, trimmed, 512, 'agent');
  return text;
}

async function borrowerTurn(persona: BorrowerPersona, agentMessages: ChatMessage[]): Promise<string> {
  const messages = agentMessages
    .filter((m) => !['[BEGIN]', '[BEGIN_CALL]'].includes(m.content))
    .map((m) => ({ role: (m.role === 'assistant' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.content }));

  if (messages.length === 0) messages.push({ role: 'user', content: '[The agent just contacted you. Respond naturally.]' });

  const { text } = await callLLM(MODEL_EVAL, PERSONA_PROMPTS[persona], messages, 150, 'test_harness');
  return text;
}

export type ConversationResult = {
  conversationId: string;
  agentId: AgentId;
  persona: BorrowerPersona;
  promptVersion: string;
  transcript: ChatMessage[];
  completed: boolean;
  turns: number;
};

function syntheticHandoff(persona: BorrowerPersona): string {
  return JSON.stringify({
    identity_verified: true, debt_amount: 12000, monthly_income: null, employment: 'unemployed', hardship: true,
    hardship_type: persona === 'distressed' ? 'medical' : 'job_loss',
    emotional_state: persona === 'combative' ? 'hostile' : persona === 'distressed' ? 'distressed' : 'calm',
    borrower_statement: persona === 'cooperative' ? 'Willing to repay but in hardship' : persona === 'combative' ? 'Disputes validity of debt' : 'Medical emergency caused default',
    offers_made: [], borrower_response: '', objections: [],
  });
}

async function runConversation(systemPrompt: string, persona: BorrowerPersona, agentId: AgentId, promptVersion: string, isComplete: (reply: string) => boolean): Promise<ConversationResult> {
  const messages: ChatMessage[] = [{ role: 'user', content: '[BEGIN]' }];
  const opening = await agentTurn(systemPrompt, messages);
  messages.push({ role: 'assistant', content: opening });

  let completed = false;
  let turns = 0;

  while (turns < MAX_TURNS && !completed) {
    const borrowerMsg = await borrowerTurn(persona, messages);
    messages.push({ role: 'user', content: borrowerMsg });
    const agentReply = await agentTurn(systemPrompt, messages);
    messages.push({ role: 'assistant', content: agentReply });
    turns++;
    if (isComplete(agentReply)) completed = true;
  }

  return { conversationId: uuidv4(), agentId, persona, promptVersion, transcript: messages, completed, turns };
}

export async function generateConversations(opts: {
  agentId: AgentId;
  promptVersion: string;
  promptText: string;
  n: number;
  seed: number;
}): Promise<ConversationResult[]> {
  const rng = new SeededRandom(opts.seed);
  const personas: BorrowerPersona[] = ['cooperative', 'combative', 'distressed'];
  const results: ConversationResult[] = [];

  for (let i = 0; i < opts.n; i++) {
    const persona = personas[i % 3] as BorrowerPersona;
    const handoff = syntheticHandoff(persona);

    const systemPrompt = opts.agentId === 'assessment'
      ? opts.promptText
      : `${opts.promptText}\n\nCONTEXT FROM PRIOR STAGES:\n${handoff}`;

    const isComplete = (reply: string): boolean => {
      if (opts.agentId === 'assessment') return /"assessment_complete"\s*:\s*true/.test(reply);
      if (opts.agentId === 'final_notice') return /"final_notice_complete"\s*:\s*true/.test(reply);
      return false;
    };

    const result = await runConversation(systemPrompt, persona, opts.agentId, opts.promptVersion, isComplete);
    results.push(result);

    const profile = rng.pick(EVAL_BORROWER_PROFILES);
    process.stdout.write(`  [${opts.agentId} v${opts.promptVersion}] ${i + 1}/${opts.n} ${persona} (${profile.name}) — turns: ${result.turns}, done: ${result.completed}\n`);
  }

  return results;
}
