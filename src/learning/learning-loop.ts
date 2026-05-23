import { v4 as uuidv4 } from 'uuid';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';
import { generateConversations } from './test-harness.js';
import type { ConversationResult } from './test-harness.js';
import { evaluateBatch } from './evaluator.js';
import { welchTTest, mean, MIN_SAMPLE_SIZE } from './stats.js';
import {
  getCurrentPrompt,
  getNextVersionNumber,
  savePromptVersion,
  adoptVersion,
  rejectVersion,
  listVersions,
} from './prompt-store.js';
import { checkCompliance } from '../compliance/compliance-checker.js';
import { runMetaEvaluation } from './meta-evaluator.js';
import { callLLM, MODEL_EVAL } from '../llm/client.js';
import { getTotalCost } from '../db/db.js';
import type { AgentId, EvaluationScore, PromptVersion } from '../types/index.js';

dotenv.config();

// ── Conversation cache — survives process restarts ────────────────────────────
// Conversations are saved to disk after generation so if evaluation hits rate
// limits and the process is restarted with a new key, we load from cache
// instead of regenerating (which would burn the new key's quota too).

const CACHE_DIR = join(process.cwd(), 'data', 'seeds', 'eval_cache');

function cacheKey(agentId: string, version: string, tag: string, seed: number): string {
  return join(CACHE_DIR, `${agentId}_${version}_${tag}_s${seed}.json`);
}

function saveConvCache(key: string, convs: ConversationResult[]): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(key, JSON.stringify(convs));
  console.log(`  [cache] saved ${convs.length} conversations → ${key.split('/').pop()}`);
}

function loadConvCache(key: string): ConversationResult[] | null {
  if (!existsSync(key)) return null;
  const convs = JSON.parse(readFileSync(key, 'utf8')) as ConversationResult[];
  console.log(`  [cache] loaded ${convs.length} conversations from cache (skipping regeneration)`);
  return convs;
}

const COST_HARD_STOP = 18; // $20 budget, stop at $18 for buffer
const CONVERSATIONS_PER_VERSION = 15; // minimum for Welch's t-test (MIN_SAMPLE_SIZE)

// ── Prompt improvement ────────────────────────────────────────────────────────

async function proposeImprovement(
  agentId: AgentId,
  currentPrompt: string,
  scores: EvaluationScore[],
): Promise<string> {
  // Find weakest metric across all conversations
  const metrics = {
    resolution_rate: mean(scores.map((s) => s.resolutionRate)),
    compliance_score: mean(scores.map((s) => s.complianceScore)),
    information_capture_rate: mean(scores.map((s) => s.informationCaptureRate)),
    handoff_quality: mean(scores.map((s) => s.handoffQuality)),
    conversation_efficiency: mean(scores.map((s) => s.conversationEfficiency)),
  };

  const weakest = Object.entries(metrics).sort(([, a], [, b]) => a - b)[0];

  // Pull worst 3 conversations for context
  const worst3 = [...scores]
    .sort((a, b) => a.overallScore - b.overallScore)
    .slice(0, 3)
    .map((s) => `Score: ${s.overallScore.toFixed(2)}\nViolations: ${s.complianceViolations.join(', ') || 'none'}\nTranscript excerpt:\n${s.rawTranscript.slice(0, 500)}`)
    .join('\n---\n');

  const prompt = `You are improving an AI debt collections agent system prompt.

Current agent: ${agentId}
Weakest metric: ${weakest[0]} (mean score: ${weakest[1].toFixed(2)}/10)
Mean overall score: ${mean(scores.map((s) => s.overallScore)).toFixed(2)}/10

Worst 3 conversations:
${worst3}

Current system prompt:
${currentPrompt}

Task: Propose a SPECIFIC, MINIMAL change to the system prompt that will improve "${weakest[0]}".
- Change at most 2-3 sentences or add 1-2 new instructions
- Do NOT remove compliance rules
- Do NOT change the tone dramatically
- Output ONLY the complete new system prompt, no explanation, no preamble.`;

  const { text } = await callLLM(
    MODEL_EVAL, '',
    [{ role: 'user', content: prompt }],
    1500, 'improvement',
  );

  return text || currentPrompt;
}

// ── Single iteration ──────────────────────────────────────────────────────────

async function runIteration(
  agentId: AgentId,
  iteration: number,
  seed: number,
): Promise<{ adopted: boolean; reason: string }> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${agentId}] Iteration ${iteration}`);
  console.log('='.repeat(60));

  // Cost guard
  const cost = await getTotalCost();
  if (cost >= COST_HARD_STOP) {
    console.log(`HARD STOP: total cost $${cost.toFixed(4)} >= $${COST_HARD_STOP}`);
    return { adopted: false, reason: 'cost_limit_reached' };
  }

  // ── Step 1: Get current prompt ────────────────────────────────────────────
  const currentVersion = await getCurrentPrompt(agentId);
  console.log(`Current prompt version: ${currentVersion.version}`);

  // ── Step 2: Generate baseline conversations (cached — survives restarts) ────
  const baselineCacheKey = cacheKey(agentId, `v${currentVersion.version}`, 'baseline', seed + iteration * 1000);
  console.log(`Generating ${CONVERSATIONS_PER_VERSION} baseline conversations…`);
  const baselineConvs = loadConvCache(baselineCacheKey) ?? await (async () => {
    const convs = await generateConversations({
      agentId,
      promptVersion: `v${currentVersion.version}`,
      promptText: currentVersion.promptText,
      n: CONVERSATIONS_PER_VERSION,
      seed: seed + iteration * 1000,
    });
    saveConvCache(baselineCacheKey, convs);
    return convs;
  })();

  // ── Step 3: Evaluate baseline ─────────────────────────────────────────────
  console.log('Evaluating baseline conversations…');
  const baselineScores = await evaluateBatch(baselineConvs);
  const baselineMean = mean(baselineScores.map((s) => s.overallScore));
  console.log(`Baseline mean score: ${baselineMean.toFixed(3)}`);

  // Update current version with evaluation data
  await savePromptVersion({
    ...currentVersion,
    evaluationData: baselineScores,
    meanScore: baselineMean,
  });

  // ── Step 3b: Meta-evaluation — runs after first evaluation batch each iteration ──
  // This is where the DGM loop lives: the system reviews its own evaluation quality
  // and patches the compliance checker if it detects blind spots (e.g. Rule 1).
  await runMetaEvaluation(agentId, baselineScores, baselineConvs);

  // ── Step 4: Compliance check on current prompt ────────────────────────────
  const complianceCheck = await checkCompliance(currentVersion.promptText);
  if (!complianceCheck.passed) {
    console.log(`COMPLIANCE FAIL on current prompt: ${complianceCheck.violations.join(', ')}`);
    // Don't block the loop — just log it. The current prompt may have pre-existing issues.
  }

  // ── Step 5: Propose improvement ───────────────────────────────────────────
  console.log('Proposing prompt improvement…');
  const newPromptText = await proposeImprovement(agentId, currentVersion.promptText, baselineScores);

  // ── Step 6: Compliance check on new prompt ────────────────────────────────
  const newCompliance = await checkCompliance(newPromptText);
  if (!newCompliance.passed) {
    console.log(`REJECTED: new prompt fails compliance — ${newCompliance.violations.join(', ')}`);
    return { adopted: false, reason: `compliance_fail: ${newCompliance.violations.join(', ')}` };
  }

  // ── Step 7: Generate conversations with new prompt (cached) ─────────────────
  const nextVersion = await getNextVersionNumber(agentId);
  const newVersionId = uuidv4();
  const newCacheKey = cacheKey(agentId, `v${nextVersion}`, 'new', seed + iteration * 1000 + 500);

  console.log(`Testing new prompt (v${nextVersion})…`);
  const newConvs = loadConvCache(newCacheKey) ?? await (async () => {
    const convs = await generateConversations({
      agentId,
      promptVersion: `v${nextVersion}`,
      promptText: newPromptText,
      n: CONVERSATIONS_PER_VERSION,
      seed: seed + iteration * 1000 + 500,
    });
    saveConvCache(newCacheKey, convs);
    return convs;
  })();

  // ── Step 8: Evaluate new prompt ───────────────────────────────────────────
  console.log('Evaluating new prompt conversations…');
  const newScores = await evaluateBatch(newConvs);
  const newMean = mean(newScores.map((s) => s.overallScore));
  console.log(`New prompt mean score: ${newMean.toFixed(3)}`);

  // ── Step 9: Statistical test ──────────────────────────────────────────────
  if (baselineScores.length < MIN_SAMPLE_SIZE || newScores.length < MIN_SAMPLE_SIZE) {
    const reason = `insufficient_samples (need ${MIN_SAMPLE_SIZE}, got ${baselineScores.length} vs ${newScores.length})`;
    console.log(`REJECTED: ${reason}`);
    return { adopted: false, reason };
  }

  const stats = welchTTest(
    newScores.map((s) => s.overallScore),
    baselineScores.map((s) => s.overallScore),
  );

  console.log(`t=${stats.tStatistic.toFixed(3)}, p=${stats.pValue.toFixed(4)}, Cohen's d=${stats.cohensD.toFixed(3)}, significant=${stats.significant}`);

  // ── Step 10: Adopt or reject ──────────────────────────────────────────────
  const newVersion: PromptVersion = {
    id: newVersionId,
    agentId,
    version: nextVersion,
    promptText: newPromptText,
    createdAt: new Date(),
    evaluationData: newScores,
    meanScore: newMean,
    pValue: stats.pValue,
    adopted: false,
    rollbackReason: null,
  };

  await savePromptVersion(newVersion);

  if (stats.significant && newMean > baselineMean) {
    await adoptVersion(newVersionId, agentId);
    console.log(`✓ ADOPTED v${nextVersion}: mean ${baselineMean.toFixed(3)} → ${newMean.toFixed(3)} (p=${stats.pValue.toFixed(4)}, d=${stats.cohensD.toFixed(3)})`);
    return { adopted: true, reason: `p=${stats.pValue.toFixed(4)}, d=${stats.cohensD.toFixed(3)}` };
  } else {
    const reason = stats.significant && newMean <= baselineMean
      ? `no_improvement (new=${newMean.toFixed(3)} <= baseline=${baselineMean.toFixed(3)})`
      : `not_significant (p=${stats.pValue.toFixed(4)}, d=${stats.cohensD.toFixed(3)})`;
    await rejectVersion(newVersionId, reason);
    console.log(`✗ REJECTED: ${reason}`);
    return { adopted: false, reason };
  }
}

// ── Full learning loop ────────────────────────────────────────────────────────

export async function runLearningLoop(
  agentId: AgentId,
  iterations: number = 3,
  seed: number = 42,
): Promise<void> {
  console.log(`\nStarting learning loop: ${agentId}, ${iterations} iterations, seed=${seed}`);

  for (let i = 1; i <= iterations; i++) {
    const result = await runIteration(agentId, i, seed);
    if (result.reason === 'cost_limit_reached') break;
  }

  // Print final summary
  const versions = await listVersions(agentId);
  console.log(`\n[${agentId}] Final prompt history:`);
  for (const v of versions) {
    const status = v.adopted ? '✓ ADOPTED' : `✗ rejected (${v.rollbackReason ?? 'n/a'})`;
    console.log(`  v${v.version}: mean=${v.meanScore.toFixed(3)}, p=${v.pValue?.toFixed(4) ?? 'n/a'} — ${status}`);
  }
}

export async function runAllAgents(iterations = 3, seed = 42): Promise<void> {
  const agents: AgentId[] = ['assessment', 'resolution', 'final_notice'];
  for (const agentId of agents) {
    await runLearningLoop(agentId, iterations, seed);
  }

  const totalCost = await getTotalCost();
  console.log(`\nTotal LLM spend: $${totalCost.toFixed(4)}`);
}
