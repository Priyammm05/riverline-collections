import dotenv from 'dotenv';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { runAllAgents, runLearningLoop } from '../src/learning/learning-loop.js';
import { listVersions } from '../src/learning/prompt-store.js';
import { db, getTotalCost } from '../src/db/db.js';

dotenv.config();

const SEED = Number(process.env.EVAL_SEED ?? 42);
const RESULTS_DIR = join(process.cwd(), 'data', 'results');

async function main(): Promise<void> {
  console.log(`\nRiverline Eval Pipeline — seed=${SEED}`);
  console.log('='.repeat(60));

  // Clear results directory
  rmSync(RESULTS_DIR, { recursive: true, force: true });
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, '.gitkeep'), '');

  // Assessment already completed (45 conversations, 3 iterations) — skip re-running.
  // Run 1 iteration each for resolution and final_notice with 15 conversations per version.
  // Note: free API tier limits (5 req/min) make 3 full iterations per agent impractical.
  const skipAssessment = process.env.SKIP_ASSESSMENT === 'true';
  if (!skipAssessment) {
    await runLearningLoop('assessment', 3, SEED);
  } else {
    console.log('Skipping assessment (already complete in DB)');
  }
  await runLearningLoop('resolution', 1, SEED);
  await runLearningLoop('final_notice', 1, SEED);

  // ── Generate CSV of all evaluation scores ─────────────────────────────────
  const scoreRows = await db.query(
    `SELECT * FROM evaluation_scores ORDER BY agent_id, prompt_version, created_at`,
  );

  const csvHeader = [
    'conversation_id', 'agent_id', 'prompt_version',
    'resolution_rate', 'compliance_score', 'information_capture_rate',
    'handoff_quality', 'conversation_efficiency', 'overall_score',
    'compliance_violations', 'timestamp',
  ].join(',');

  const csvRows = scoreRows.rows.map((r) =>
    [
      r.conversation_id, r.agent_id, r.prompt_version,
      r.resolution_rate, r.compliance_score, r.information_capture_rate,
      r.handoff_quality, r.conversation_efficiency, r.overall_score,
      `"${(r.compliance_violations as string[]).join('; ')}"`,
      r.created_at,
    ].join(','),
  );

  writeFileSync(join(RESULTS_DIR, 'evaluation_scores.csv'), [csvHeader, ...csvRows].join('\n'));
  console.log(`\nCSV written: data/results/evaluation_scores.csv (${csvRows.length} rows)`);

  // ── Generate evolution report JSON ────────────────────────────────────────
  const agentIds = ['assessment', 'resolution', 'final_notice'] as const;
  const evolutionReport = await Promise.all(
    agentIds.map(async (agentId) => {
      const versions = await listVersions(agentId);
      const metaRows = await db.query(
        `SELECT * FROM meta_evaluation_findings WHERE fix_adopted = TRUE`,
      );
      return {
        agent_id: agentId,
        versions: versions.map((v) => ({
          version: v.version,
          n_conversations: v.evaluationData.length,
          mean_score: parseFloat(v.meanScore.toFixed(3)),
          std_dev: v.evaluationData.length > 1
            ? parseFloat(stdDev(v.evaluationData.map((e) => e.overallScore)).toFixed(3))
            : null,
          p_value_vs_prev: v.pValue !== null ? parseFloat(v.pValue.toFixed(4)) : null,
          adopted: v.adopted,
          rollback_reason: v.rollbackReason,
        })),
        meta_evaluation_findings: metaRows.rows.map((r) => ({
          flaw: r.flaw,
          fix: r.proposed_fix,
          adopted: r.fix_adopted,
        })),
      };
    }),
  );

  writeFileSync(
    join(RESULTS_DIR, 'evolution_report.json'),
    JSON.stringify(evolutionReport, null, 2),
  );
  console.log('JSON written: data/results/evolution_report.json');

  // ── Cost breakdown ─────────────────────────────────────────────────────────
  const costRows = await db.query(
    `SELECT purpose, model, SUM(cost) as total_cost, SUM(input_tokens) as total_input,
            SUM(output_tokens) as total_output, COUNT(*) as calls
     FROM api_cost_log GROUP BY purpose, model ORDER BY total_cost DESC`,
  );

  console.log('\nCost breakdown:');
  for (const r of costRows.rows) {
    console.log(`  ${r.purpose} / ${r.model}: $${parseFloat(r.total_cost).toFixed(4)} (${r.calls} calls, ${r.total_input}+${r.total_output} tokens)`);
  }
  console.log(`Total: $${(await getTotalCost()).toFixed(4)}`);

  await db.end();
}

function stdDev(arr: number[]): number {
  const m = arr.reduce((s, x) => s + x, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

main().catch((err) => { console.error(err); process.exit(1); });
