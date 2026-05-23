import { Context } from '@temporalio/activity';
import { v4 as uuidv4 } from 'uuid';
import { FinalNoticeAgent } from '../../agents/final-notice.agent.js';
import { db } from '../../db/db.js';
import type { BorrowerProfile, HandoffPayload } from '../../types/index.js';

// Canned cooperative script for autonomous runs (learning loop uses LLM borrower from Phase 5).
const COOPERATIVE_SCRIPT = [
  'I understand this is serious.',
  'What exactly happens in 72 hours?',
  'Is there any flexibility on the payment amount?',
  'OK, I can try to make the payment. What do I need to do?',
];

export async function runFinalNoticeActivity(
  borrowerProfile: BorrowerProfile,
  handoff: HandoffPayload,
  workflowId?: string,
): Promise<'resolved' | 'no_resolution'> {
  Context.current().heartbeat('final-notice-started');

  // Load handoff context — the agent's system prompt injects this directly
  const agent = new FinalNoticeAgent(borrowerProfile, handoff.content);
  await agent.start();

  let outcome: 'resolved' | 'no_resolution' = 'no_resolution';

  for (let i = 0; i < COOPERATIVE_SCRIPT.length + 2 && outcome === 'no_resolution'; i++) {
    Context.current().heartbeat(`final-notice-turn-${i}`);

    const msg = i < COOPERATIVE_SCRIPT.length
      ? COOPERATIVE_SCRIPT[i]
      : 'I need more time to think about this.';

    const turn = await agent.chat(msg);
    if (turn.complete && turn.outcome) {
      outcome = turn.outcome.outcome;
    }
  }

  if (workflowId) {
    await db.query(
      `INSERT INTO conversation_transcripts
         (id, workflow_id, agent_id, modality, transcript, token_count)
       VALUES ($1, $2, 'final_notice', 'chat', $3, $4)`,
      [uuidv4(), workflowId, JSON.stringify(agent.getMessages()), agent.getContextTokenCount()],
    );
  }

  return outcome;
}
