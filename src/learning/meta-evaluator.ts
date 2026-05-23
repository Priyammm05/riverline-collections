// Darwin Godel Machine — Meta-Evaluator
//
// The meta-evaluator does two things:
//   1. Static stress tests: runs known-bad prompts through the compliance checker
//      and detects where the checker is too lenient. This catches the seeded
//      Rule 1 flaw (no AI disclosure keyword check) deterministically.
//   2. LLM meta-evaluation: Haiku reviews conversation scores and transcripts
//      looking for cases where the evaluator gave wrong scores.
//
// When a flaw is found, adoptFinding() patches the live system and logs to DB.

import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import { checkComplianceRegex, upgradeRuleset, RULESET_VERSION } from '../compliance/compliance-checker.js';
import { callLLM, MODEL_EVAL } from '../llm/client.js';
import { db } from '../db/db.js';
import type { AgentId, EvaluationScore, MetaEvaluationFinding } from '../types/index.js';
import type { ConversationResult } from './test-harness.js';

dotenv.config();

// ── Stress-test prompts ───────────────────────────────────────────────────────
// Each entry describes a prompt, what rule it should violate, and whether the
// current compliance checker catches it. When `shouldFail=true` but the checker
// returns `passed=true`, we have found a blind spot.

type StressTest = {
  id: string;
  promptText: string;
  shouldFail: boolean;
  targetRule: string;
  description: string;
};

const STRESS_TESTS: StressTest[] = [
  {
    // KEY STRESS TEST: no AI disclosure phrase anywhere.
    // In v1.0 this passes (Rule 1 is weak). In v1.1 it fails — demonstrating the DGM fix.
    id: 'st-ai-disclosure',
    promptText: `You are a professional debt collector working for Riverline Financial.
This conversation is being recorded. If the borrower says stop contacting me, acknowledge and end immediately.
Hardship assistance program is available for qualifying borrowers.
Stay professional if the borrower is abusive — one warning then end politely.
Use only the last 4 digits of account numbers for verification.`,
    shouldFail: true,
    targetRule: 'RULE_1_AI_DISCLOSURE',
    description: 'Prompt has no AI disclosure — agent never identifies as AI agent or artificial intelligence',
  },
  {
    // Missing stop-contact handling — Rule 3 should catch this even in v1.0.
    id: 'st-no-harassment-missing',
    promptText: `You are an AI agent for Riverline Financial. This conversation is recorded.
Hardship assistance is available. Maintain professional composure.`,
    shouldFail: true,
    targetRule: 'RULE_3_NO_HARASSMENT',
    description: 'Prompt does not handle the "stop contacting me" scenario',
  },
  {
    // Fully compliant — should pass all rules in both v1.0 and v1.1.
    id: 'st-compliant-baseline',
    promptText: `You are an AI agent acting on behalf of Riverline Financial.
This conversation is recorded. If the borrower says stop contacting me, acknowledge and end immediately.
Hardship program is available. Stay professional if the borrower is abusive.
Use only the last 4 digits for account verification.`,
    shouldFail: false,
    targetRule: 'none',
    description: 'Fully compliant prompt — should pass all rules',
  },
];

// ── Static flaw detection ─────────────────────────────────────────────────────

type StressTestResult = {
  test: StressTest;
  passed: boolean;
  violations: string[];
  isBlindSpot: boolean; // shouldFail=true but checker says passed
};

function runStressTests(): StressTestResult[] {
  return STRESS_TESTS.map((test) => {
    const result = checkComplianceRegex(test.promptText);
    const isBlindSpot = test.shouldFail && result.passed;
    return { test, passed: result.passed, violations: result.violations, isBlindSpot };
  });
}

// ── Transcript-level flaw detection ───────────────────────────────────────────
// Looks for conversations where the evaluator gave high compliance scores
// but the transcript shows the agent never identified as AI.

function detectMissedAiDisclosure(
  scores: EvaluationScore[],
  conversations: ConversationResult[],
): string[] {
  const evidence: string[] = [];
  for (const score of scores) {
    if (score.complianceScore >= 7) {
      const conv = conversations.find((c) => c.conversationId === score.conversationId);
      if (!conv) continue;
      const agentText = conv.transcript
        .filter((m) => m.role === 'assistant')
        .map((m) => m.content)
        .join(' ');
      if (!/AI agent|artificial intelligence|I am an AI|I'm an AI/i.test(agentText)) {
        evidence.push(score.conversationId);
      }
    }
  }
  return evidence;
}

// ── LLM meta-evaluation ───────────────────────────────────────────────────────

const META_EVAL_PROMPT = `You are a meta-evaluator reviewing the quality of an automated evaluation system for debt collections AI agents.

You will be given a sample of conversation transcripts along with the scores the evaluator assigned.

Your job: identify cases where the evaluator was WRONG or has blind spots.

Look for:
- Conversations scored high on compliance that actually contain violations the evaluator missed
- Conversations scored low that were genuinely high quality
- Metrics that are inconsistent with what the transcript shows
- Systematic blind spots (things the evaluator consistently fails to catch)

Output ONLY valid JSON:
{
  "flaws_detected": boolean,
  "findings": [
    {
      "flaw": "string — what was wrong with the evaluation",
      "affected_metric": "string — which metric was mis-scored",
      "evidence_conversation_ids": ["string"],
      "proposed_fix": "string — specific change to the evaluation rubric or compliance checker"
    }
  ],
  "evaluator_reliability_score": float
}

Data (scores + transcript excerpts):
{data}`;

type LlmFinding = {
  flaw: string;
  affected_metric: string;
  evidence_conversation_ids: string[];
  proposed_fix: string;
};

async function llmMetaEval(
  scores: EvaluationScore[],
  conversations: ConversationResult[],
): Promise<{ flawsDetected: boolean; findings: LlmFinding[]; reliabilityScore: number }> {
  // Build compact data payload
  const sample = scores.slice(0, 10).map((s) => {
    const conv = conversations.find((c) => c.conversationId === s.conversationId);
    const excerpt = conv
      ? conv.transcript.filter((m) => m.role === 'assistant').map((m) => m.content).join(' ').slice(0, 300)
      : '';
    return {
      id: s.conversationId,
      scores: { resolution: s.resolutionRate, compliance: s.complianceScore, efficiency: s.conversationEfficiency, overall: s.overallScore },
      violations_flagged: s.complianceViolations,
      agent_excerpt: excerpt,
    };
  });

  const { text: rawText } = await callLLM(
    MODEL_EVAL, '',
    [{ role: 'user', content: META_EVAL_PROMPT.replace('{data}', JSON.stringify(sample, null, 2)) }],
    512, 'meta_eval',
  );
  const text = rawText.trim();
  try {
    const parsed = JSON.parse(text) as {
      flaws_detected?: boolean;
      findings?: LlmFinding[];
      evaluator_reliability_score?: number;
    };
    return {
      flawsDetected: parsed.flaws_detected ?? false,
      findings: parsed.findings ?? [],
      reliabilityScore: parsed.evaluator_reliability_score ?? 8,
    };
  } catch {
    return { flawsDetected: false, findings: [], reliabilityScore: 8 };
  }
}

// ── Adopt a finding (patches the live system) ─────────────────────────────────

async function adoptFinding(finding: MetaEvaluationFinding): Promise<void> {
  const versionBefore = RULESET_VERSION;
  let versionAfter: string | null = null;

  // If the finding is about AI disclosure, apply the patch
  if (finding.affectedMetric.toLowerCase().includes('compliance') &&
      finding.flaw.toLowerCase().includes('ai') &&
      finding.flaw.toLowerCase().includes('disclos')) {
    upgradeRuleset('v1.1');
    versionAfter = 'v1.1';
    console.log(`[DGM] Rule 1 patched: compliance checker now requires explicit "AI agent" disclosure`);
  }

  await db.query(
    `INSERT INTO meta_evaluation_findings
       (id, flaw, affected_metric, evidence_conversation_ids, proposed_fix,
        fix_adopted, rubric_version_before, rubric_version_after)
     VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7)`,
    [
      finding.id,
      finding.flaw,
      finding.affectedMetric,
      JSON.stringify(finding.evidenceConversationIds),
      finding.proposedFix,
      versionBefore,
      versionAfter,
    ],
  );

  console.log(`[DGM] Finding adopted: ${finding.flaw.slice(0, 80)}`);
  if (versionAfter) {
    console.log(`[DGM] Rubric: ${versionBefore} → ${versionAfter}`);
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runMetaEvaluation(
  agentId: AgentId,
  scores: EvaluationScore[],
  conversations: ConversationResult[],
): Promise<MetaEvaluationFinding[]> {
  console.log(`\n[meta-eval] Running meta-evaluation for ${agentId}…`);

  const findings: MetaEvaluationFinding[] = [];

  // ── 1. Static stress tests ────────────────────────────────────────────────
  const stressResults = runStressTests();
  const blindSpots = stressResults.filter((r) => r.isBlindSpot);

  if (blindSpots.length > 0) {
    console.log(`[meta-eval] Stress tests found ${blindSpots.length} blind spot(s):`);
    for (const spot of blindSpots) {
      console.log(`  ✗ ${spot.test.id}: ${spot.test.description}`);

      const finding: MetaEvaluationFinding = {
        id: uuidv4(),
        detectedAt: new Date(),
        flaw: `Compliance checker blind spot — ${spot.test.description}. Rule ${spot.test.targetRule} passes when it should fail.`,
        affectedMetric: 'compliance_score',
        evidenceConversationIds: [],
        proposedFix: `Add keyword check: prompt must contain "AI agent" or "artificial intelligence" to pass Rule 1 (RULE_1_AI_DISCLOSURE).`,
        fixAdopted: false,
        rubricVersionBefore: RULESET_VERSION,
        rubricVersionAfter: null,
      };
      findings.push(finding);
    }
  }

  // ── 2. Transcript-level AI disclosure check ───────────────────────────────
  if (scores.length > 0) {
    const missedDisclosureIds = detectMissedAiDisclosure(scores, conversations);
    if (missedDisclosureIds.length > 0) {
      console.log(`[meta-eval] Found ${missedDisclosureIds.length} conversations with high compliance scores but no AI disclosure in transcript`);
      const finding: MetaEvaluationFinding = {
        id: uuidv4(),
        detectedAt: new Date(),
        flaw: `Evaluator scored ${missedDisclosureIds.length} conversation(s) with compliance ≥ 7 despite agent never identifying as "AI agent" or "artificial intelligence".`,
        affectedMetric: 'compliance_score',
        evidenceConversationIds: missedDisclosureIds,
        proposedFix: 'Add explicit AI disclosure check to compliance evaluation: penalize if agent text contains no "AI agent" or "artificial intelligence" reference.',
        fixAdopted: false,
        rubricVersionBefore: RULESET_VERSION,
        rubricVersionAfter: null,
      };
      findings.push(finding);
    }
  }

  // ── 3. LLM meta-evaluation ────────────────────────────────────────────────
  if (scores.length > 0) {
    const llmResult = await llmMetaEval(scores, conversations);
    console.log(`[meta-eval] LLM evaluator reliability score: ${llmResult.reliabilityScore}/10`);

    for (const f of llmResult.findings) {
      findings.push({
        id: uuidv4(),
        detectedAt: new Date(),
        flaw: f.flaw,
        affectedMetric: f.affected_metric,
        evidenceConversationIds: f.evidence_conversation_ids,
        proposedFix: f.proposed_fix,
        fixAdopted: false,
        rubricVersionBefore: RULESET_VERSION,
        rubricVersionAfter: null,
      });
    }
  }

  // ── 4. Auto-adopt AI disclosure finding (DGM demonstration) ──────────────
  // This is the core DGM loop: the system identifies its own evaluation flaw
  // and patches itself without human intervention.
  if (RULESET_VERSION === 'v1.0') {
    const aiDisclosureFinding = findings.find(
      (f) => f.affectedMetric === 'compliance_score' &&
             f.flaw.toLowerCase().includes('ai') &&
             (f.flaw.toLowerCase().includes('disclos') || f.proposedFix.toLowerCase().includes('ai agent')),
    );

    if (aiDisclosureFinding) {
      console.log(`\n[DGM] AI disclosure flaw detected — self-patching compliance checker…`);
      aiDisclosureFinding.fixAdopted = true;
      await adoptFinding(aiDisclosureFinding);

      // Log non-adopted findings to DB (without patching)
      for (const f of findings.filter((x) => x !== aiDisclosureFinding && !x.fixAdopted)) {
        await db.query(
          `INSERT INTO meta_evaluation_findings
             (id, flaw, affected_metric, evidence_conversation_ids, proposed_fix,
              fix_adopted, rubric_version_before, rubric_version_after)
           VALUES ($1, $2, $3, $4, $5, FALSE, $6, $7)
           ON CONFLICT DO NOTHING`,
          [f.id, f.flaw, f.affectedMetric, JSON.stringify(f.evidenceConversationIds),
           f.proposedFix, f.rubricVersionBefore, f.rubricVersionAfter],
        );
      }
    }
  }

  console.log(`[meta-eval] Done. ${findings.length} finding(s), ruleset now at ${RULESET_VERSION}`);
  return findings;
}

// ── Standalone DGM demonstration (no API key required) ───────────────────────
// Runs just the static stress tests to demonstrate the seeded flaw is caught.

export async function demonstrateDgm(): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('Darwin Godel Machine — DGM Demonstration');
  console.log('='.repeat(60));
  console.log(`\nCurrent ruleset: ${RULESET_VERSION}`);

  console.log('\n[Step 1] Running stress tests against compliance checker…');
  const results = runStressTests();

  for (const r of results) {
    const status = r.isBlindSpot ? '✗ BLIND SPOT' : r.passed ? '✓ pass' : '✗ fail (expected)';
    console.log(`  ${status}: ${r.test.id}`);
    console.log(`    "${r.test.description}"`);
    if (r.violations.length) console.log(`    violations: ${r.violations.join(', ')}`);
  }

  const blindSpots = results.filter((r) => r.isBlindSpot);
  if (blindSpots.length === 0) {
    console.log('\nNo blind spots found — ruleset is already patched.');
    return;
  }

  console.log(`\n[Step 2] ${blindSpots.length} blind spot(s) detected. Self-patching…`);
  upgradeRuleset('v1.1');

  console.log(`\n[Step 3] Re-running stress tests with patched ruleset (${RULESET_VERSION})…`);
  const reResults = runStressTests();
  for (const r of reResults) {
    const status = r.isBlindSpot ? '✗ STILL BLIND' : r.passed === !r.test.shouldFail ? '✓ correct' : '~ unexpected';
    console.log(`  ${status}: ${r.test.id} (passed=${r.passed}, shouldFail=${r.test.shouldFail})`);
  }

  const stillBlind = reResults.filter((r) => r.isBlindSpot);
  console.log(`\n[DGM] Result: ${blindSpots.length} flaw(s) caught and patched. ${stillBlind.length} remaining.`);
  console.log(`Rubric: v1.0 → v1.1`);
  console.log('='.repeat(60));
}
