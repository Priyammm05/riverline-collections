import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/db.js';
import type { AgentId, EvaluationScore, PromptVersion } from '../types/index.js';
import { buildAssessmentPrompt } from '../agents/assessment.agent.js';
import { buildResolutionPrompt } from '../agents/resolution.agent.js';
import { buildFinalNoticePrompt } from '../agents/final-notice.agent.js';

// ── Seed prompts (version 1 for each agent) ───────────────────────────────────

const SEED_PROFILE = {
  borrowerId: 'seed',
  name: 'Borrower',
  partialAccountNumber: '0000',
  debtAmount: 0,
  loanType: 'personal',
};

function seedPromptFor(agentId: AgentId): string {
  switch (agentId) {
    case 'assessment':    return buildAssessmentPrompt(SEED_PROFILE);
    case 'resolution':    return buildResolutionPrompt();
    case 'final_notice':  return buildFinalNoticePrompt('No prior context available.');
  }
}

// ── DB row type ───────────────────────────────────────────────────────────────

type PromptVersionRow = {
  id: string;
  agent_id: string;
  version_number: number;
  prompt_text: string;
  mean_score: number | null;
  p_value: number | null;
  adopted: boolean;
  rollback_reason: string | null;
  evaluation_data: EvaluationScore[] | null;
  created_at: Date;
};

function rowToVersion(r: PromptVersionRow): PromptVersion {
  return {
    id: r.id,
    agentId: r.agent_id,
    version: r.version_number,
    promptText: r.prompt_text,
    createdAt: r.created_at,
    evaluationData: r.evaluation_data ?? [],
    meanScore: r.mean_score ?? 0,
    pValue: r.p_value,
    adopted: r.adopted,
    rollbackReason: r.rollback_reason,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

// Returns the currently-adopted prompt version. Seeds version 1 on first call.
export async function getCurrentPrompt(agentId: AgentId): Promise<PromptVersion> {
  const result = await db.query<PromptVersionRow>(
    `SELECT * FROM prompt_versions
     WHERE agent_id = $1 AND adopted = TRUE
     ORDER BY version_number DESC LIMIT 1`,
    [agentId],
  );

  if (result.rows.length > 0) return rowToVersion(result.rows[0]);

  // First time — seed version 1
  return savePromptVersion({
    id: uuidv4(),
    agentId,
    version: 1,
    promptText: seedPromptFor(agentId),
    createdAt: new Date(),
    evaluationData: [],
    meanScore: 0,
    pValue: null,
    adopted: true,
    rollbackReason: null,
  });
}

export async function getNextVersionNumber(agentId: AgentId): Promise<number> {
  const result = await db.query<{ max: number }>(
    `SELECT COALESCE(MAX(version_number), 0) + 1 AS max FROM prompt_versions WHERE agent_id = $1`,
    [agentId],
  );
  return result.rows[0].max;
}

export async function savePromptVersion(version: PromptVersion): Promise<PromptVersion> {
  await db.query(
    `INSERT INTO prompt_versions
       (id, agent_id, version_number, prompt_text, mean_score, p_value, adopted, rollback_reason, evaluation_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       mean_score = EXCLUDED.mean_score,
       p_value = EXCLUDED.p_value,
       adopted = EXCLUDED.adopted,
       rollback_reason = EXCLUDED.rollback_reason,
       evaluation_data = EXCLUDED.evaluation_data`,
    [
      version.id,
      version.agentId,
      version.version,
      version.promptText,
      version.meanScore,
      version.pValue,
      version.adopted,
      version.rollbackReason,
      JSON.stringify(version.evaluationData),
    ],
  );
  return version;
}

export async function adoptVersion(id: string, agentId: AgentId): Promise<void> {
  // Un-adopt all current versions for this agent, then adopt the new one.
  await db.query(`UPDATE prompt_versions SET adopted = FALSE WHERE agent_id = $1`, [agentId]);
  await db.query(`UPDATE prompt_versions SET adopted = TRUE WHERE id = $1`, [id]);
}

export async function rejectVersion(id: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE prompt_versions SET adopted = FALSE, rollback_reason = $2 WHERE id = $1`,
    [id, reason],
  );
}

export async function listVersions(agentId: AgentId): Promise<PromptVersion[]> {
  const result = await db.query<PromptVersionRow>(
    `SELECT * FROM prompt_versions WHERE agent_id = $1 ORDER BY version_number ASC`,
    [agentId],
  );
  return result.rows.map(rowToVersion);
}

// Rollback: un-adopt current, re-adopt the previous version.
export async function rollback(agentId: AgentId, reason: string): Promise<PromptVersion | null> {
  const versions = await listVersions(agentId);
  const adopted = versions.filter((v) => v.adopted);
  const current = adopted[adopted.length - 1];
  if (!current) return null;

  const prev = versions.filter((v) => v.version < current.version).pop();
  if (!prev) return null;

  await db.query(`UPDATE prompt_versions SET adopted = FALSE, rollback_reason = $2 WHERE id = $1`, [
    current.id,
    reason,
  ]);
  await db.query(`UPDATE prompt_versions SET adopted = TRUE WHERE id = $1`, [prev.id]);
  return prev;
}
