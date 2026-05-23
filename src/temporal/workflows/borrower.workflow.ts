import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import type { BorrowerWorkflowInput, WorkflowOutcome } from '../../types/index.js';
import type * as assessmentActivities from '../activities/assessment.activity.js';
import type * as resolutionActivities from '../activities/resolution.activity.js';
import type * as finalNoticeActivities from '../activities/final-notice.activity.js';

// ── Signals ───────────────────────────────────────────────────────────────────
// Used by the HTTP chat endpoint to advance the workflow after each agent completes.
// Signals are fire-and-forget (vs Updates which need to be enabled on the namespace).

export const vapiCallEndedSignal   = defineSignal<[string]>('callEnded');
export const assessmentDoneSignal  = defineSignal<[void]>('assessmentDone');
export const finalNoticeDoneSignal = defineSignal<['resolved' | 'no_resolution']>('finalNoticeDone');

// ── Activity proxies ──────────────────────────────────────────────────────────

const { runAssessmentActivity, summarizeAssessmentActivity } = proxyActivities<
  typeof assessmentActivities
>({ startToCloseTimeout: '30 minutes', retry: { maximumAttempts: 3 } });

const {
  createResolutionCallActivity,
  parseResolutionResultActivity,
  summarizeResolutionActivity,
} = proxyActivities<typeof resolutionActivities>({
  startToCloseTimeout: '60 minutes',
  retry: { maximumAttempts: 1 },
});

const { runFinalNoticeActivity } = proxyActivities<typeof finalNoticeActivities>({
  startToCloseTimeout: '30 minutes',
  retry: { maximumAttempts: 3 },
});

// ── Workflow ──────────────────────────────────────────────────────────────────

export async function borrowerWorkflow(input: BorrowerWorkflowInput): Promise<WorkflowOutcome> {
  const { borrowerProfile, maxAssessmentRetries, mode } = input;
  const wfId = workflowInfo().workflowId;

  // ── Stage 1: Assessment (chat) ────────────────────────────────────────────
  let a1HandoffContent = '';

  if (mode === 'autonomous') {
    for (let attempt = 0; attempt < maxAssessmentRetries; attempt++) {
      try { await runAssessmentActivity(borrowerProfile, wfId); break; }
      catch { if (attempt === maxAssessmentRetries - 1) break; await sleep('5 minutes'); }
    }
    const handoff = await summarizeAssessmentActivity(wfId);
    a1HandoffContent = handoff.content;

  } else {
    // Interactive: HTTP chat endpoint signals us when A1 is done.
    // The endpoint handles the conversation and stores transcript in DB.
    let a1Done = false;
    setHandler(assessmentDoneSignal, () => { a1Done = true; });
    await condition(() => a1Done, '30 minutes');
    const handoff = await summarizeAssessmentActivity(wfId);
    a1HandoffContent = handoff.content;
  }

  // ── Stage 2: Resolution (voice via Vapi) ──────────────────────────────────
  const a1Handoff = { tokenCount: 0, content: a1HandoffContent };
  await createResolutionCallActivity(borrowerProfile, a1Handoff, wfId);

  let vapiTranscript = '';
  let callEnded = false;
  setHandler(vapiCallEndedSignal, (transcript: string) => { vapiTranscript = transcript; callEnded = true; });
  await condition(() => callEnded, '60 minutes');

  const resolutionResult = await parseResolutionResultActivity(vapiTranscript, wfId);
  // Always proceed to Agent 3 — written confirmation of whatever was agreed,
  // with legal consequences if the borrower fails to follow through.

  // ── Stage 3: Final Notice (chat) ──────────────────────────────────────────
  // Pass deal outcome so Agent 3 knows whether to confirm or escalate.
  const dealContext = resolutionResult.borrowerResponse === 'accepted'
    ? `DEAL AGREED ON CALL: ${resolutionResult.offerTerms || 'payment plan accepted'}`
    : `NO DEAL ON CALL: borrower_response=${resolutionResult.borrowerResponse}`;
  const a2Handoff = await summarizeResolutionActivity(wfId, `${vapiTranscript}\n\n[OUTCOME] ${dealContext}`);

  if (mode === 'autonomous') {
    const finalResult = await runFinalNoticeActivity(borrowerProfile, a2Handoff, wfId);
    if (finalResult === 'resolved') return { status: 'resolved', details: 'Resolved after final notice.' };

  } else {
    // Interactive: HTTP chat handles A3, signals us when done.
    let a3Resolved = false;
    let a3Done = false;
    setHandler(finalNoticeDoneSignal, (outcome: 'resolved' | 'no_resolution') => {
      a3Resolved = outcome === 'resolved';
      a3Done = true;
    });
    await condition(() => a3Done, '30 minutes');
    if (a3Resolved) return { status: 'resolved', details: 'Resolved after final notice.' };
  }

  return { status: 'legal_referral', reason: 'No resolution after final notice.' };
}
