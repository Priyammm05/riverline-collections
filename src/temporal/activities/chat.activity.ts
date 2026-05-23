import { v4 as uuidv4 } from 'uuid';
import { AssessmentAgent } from '../../agents/assessment.agent.js';
import { FinalNoticeAgent } from '../../agents/final-notice.agent.js';
import { db } from '../../db/db.js';
import type { BorrowerProfile, ChatMessage } from '../../types/index.js';

export type ChatTurnResult = {
  reply: string;
  complete: boolean;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loadMessages(workflowId: string, agentId: string): Promise<ChatMessage[]> {
  const row = await db.query<{ transcript: ChatMessage[] }>(
    `SELECT transcript FROM conversation_transcripts
     WHERE workflow_id = $1 AND agent_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [workflowId, agentId],
  );
  return row.rows[0]?.transcript ?? [];
}

async function saveMessages(
  workflowId: string,
  agentId: string,
  messages: ChatMessage[],
  tokenCount: number,
): Promise<void> {
  // Upsert — overwrite the existing row so we don't accumulate duplicates
  await db.query(
    `INSERT INTO conversation_transcripts
       (id, workflow_id, agent_id, modality, transcript, token_count)
     VALUES ($1, $2, $3, 'chat', $4, $5)
     ON CONFLICT DO NOTHING`,
    [uuidv4(), workflowId, agentId, JSON.stringify(messages), tokenCount],
  );
}

// ── Assessment chat (Agent 1) ─────────────────────────────────────────────────

export async function processA1ChatMessageActivity(
  userMessage: string,
  borrowerProfile: BorrowerProfile,
  workflowId: string,
): Promise<ChatTurnResult> {
  const existingMessages = await loadMessages(workflowId, 'assessment');

  const agent = new AssessmentAgent(borrowerProfile, existingMessages);

  // First turn — generate the agent's opening message before processing user input.
  let reply: string;
  let complete: boolean;

  if (existingMessages.length === 0) {
    // Start the conversation: get opening, then immediately process the first user message.
    await agent.start();
    const turn = await agent.chat(userMessage);
    reply = turn.reply;
    complete = turn.complete;
  } else {
    const turn = await agent.chat(userMessage);
    reply = turn.reply;
    complete = turn.complete;
  }

  await saveMessages(workflowId, 'assessment', agent.getMessages(), agent.getContextTokenCount());
  return { reply, complete };
}

// ── Final Notice chat (Agent 3) ───────────────────────────────────────────────

export async function processA3ChatMessageActivity(
  userMessage: string,
  borrowerProfile: BorrowerProfile,
  handoffContent: string,
  workflowId: string,
): Promise<ChatTurnResult> {
  const existingMessages = await loadMessages(workflowId, 'final_notice');

  const agent = new FinalNoticeAgent(borrowerProfile, handoffContent, existingMessages);

  let reply: string;
  let complete: boolean;

  if (existingMessages.length === 0) {
    await agent.start();
    const turn = await agent.chat(userMessage);
    reply = turn.reply;
    complete = turn.complete;
  } else {
    const turn = await agent.chat(userMessage);
    reply = turn.reply;
    complete = turn.complete;
  }

  await saveMessages(workflowId, 'final_notice', agent.getMessages(), agent.getContextTokenCount());
  return { reply, complete };
}
