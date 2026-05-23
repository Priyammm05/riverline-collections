import { Context } from '@temporalio/activity';
import { v4 as uuidv4 } from 'uuid';
import { AssessmentAgent } from '../../agents/assessment.agent.js';
import { summarize } from '../../summarizer/context-summarizer.js';
import { db } from '../../db/db.js';
import type { BorrowerProfile, AssessmentResult, HandoffPayload } from '../../types/index.js';

// Canned cooperative borrower script for autonomous runs (learning loop uses LLM borrower).
const COOPERATIVE_SCRIPT = [
  'Yes, this is me. My account ends in {last4}.',
  'Yes, the ${{amount}} debt is mine.',
  'I lost my job 3 months ago. My income is currently $0.',
  "I'm unemployed. I also had a medical emergency which made things worse.",
  "I want to repay but I'm in financial hardship and can't afford the full amount right now.",
];

function fillScript(template: string, profile: BorrowerProfile): string {
  return template
    .replace('{last4}', profile.partialAccountNumber)
    .replace('{{amount}}', profile.debtAmount.toString());
}

export async function runAssessmentActivity(
  borrowerProfile: BorrowerProfile,
  workflowId: string,
): Promise<AssessmentResult | null> {
  Context.current().heartbeat('assessment-started');

  const agent = new AssessmentAgent(borrowerProfile);
  await agent.start();

  let result: AssessmentResult | null = null;

  for (let i = 0; i < COOPERATIVE_SCRIPT.length + 2 && !result; i++) {
    Context.current().heartbeat(`assessment-turn-${i}`);

    const msg =
      i < COOPERATIVE_SCRIPT.length
        ? fillScript(COOPERATIVE_SCRIPT[i], borrowerProfile)
        : 'I understand. Please proceed.';

    const turn = await agent.chat(msg);
    if (turn.complete && turn.result) result = turn.result;
  }

  // Persist transcript — summarizeAssessmentActivity reads it back via workflowId.
  const transcriptId = uuidv4();
  await db.query(
    `INSERT INTO conversation_transcripts
       (id, workflow_id, agent_id, modality, transcript, token_count)
     VALUES ($1, $2, 'assessment', 'chat', $3, $4)`,
    [transcriptId, workflowId, JSON.stringify(agent.getMessages()), agent.getContextTokenCount()],
  );

  return result;
}

// Reads the transcript stored by runAssessmentActivity, then summarises it.
// Keeping transcript out of workflow args avoids bloating Temporal's event history.
export async function summarizeAssessmentActivity(workflowId: string): Promise<HandoffPayload> {
  const row = await db.query<{ transcript: { role: 'user' | 'assistant'; content: string }[] }>(
    `SELECT transcript FROM conversation_transcripts
     WHERE workflow_id = $1 AND agent_id = 'assessment'
     ORDER BY created_at DESC LIMIT 1`,
    [workflowId],
  );

  if (!row.rows.length) {
    throw new Error(`No assessment transcript found for workflow ${workflowId}`);
  }

  const messages = row.rows[0].transcript;
  const handoff = await summarize(messages);

  await db.query(
    `INSERT INTO handoff_payloads
       (id, workflow_id, from_agent, to_agent, payload, token_count)
     VALUES ($1, $2, 'assessment', 'resolution', $3, $4)`,
    [uuidv4(), workflowId, handoff.content, handoff.tokenCount],
  );

  return handoff;
}
