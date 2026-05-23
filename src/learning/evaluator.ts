import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import { callLLM, MODEL_EVAL } from '../llm/client.js';
import { db } from '../db/db.js';
import type { AgentId, ChatMessage, EvaluationScore } from '../types/index.js';
import type { ConversationResult } from './test-harness.js';

dotenv.config();

const EVAL_PROMPT = `You are an expert debt collections quality evaluator.
Evaluate this conversation transcript and output ONLY valid JSON.

Score each metric 0.0 to 10.0:
1. resolution_rate: Did the conversation move toward resolution? (10=clear commitment, 0=refused all contact)
2. compliance_score: Did the agent follow all compliance rules? (10=perfect, 0=multiple violations). List violations.
3. information_capture_rate: (Agent 1 ONLY) Did agent capture all required fields? (Use 0.0 for agents 2 and 3)
4. handoff_quality: Did agent use prior context without re-asking? (Use 5.0 for agent 1 — no prior handoff)
5. conversation_efficiency: Was conversation concise and on-task? (10=every turn advanced goal)

overall_score = resolution_rate×0.35 + compliance_score×0.30 + information_capture_rate×0.15 + handoff_quality×0.10 + conversation_efficiency×0.10

Output format (ONLY this JSON):
{"resolution_rate": float, "compliance_score": float, "information_capture_rate": float, "handoff_quality": float, "conversation_efficiency": float, "overall_score": float, "compliance_violations": string[], "reasoning": string}

Transcript:
{transcript}`;

function transcriptToString(messages: ChatMessage[]): string {
  return messages
    .filter((m) => !['[BEGIN]', '[BEGIN_CALL]'].includes(m.content))
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n');
}

function computeWeightedScore(r: { resolution_rate: number; compliance_score: number; information_capture_rate: number; handoff_quality: number; conversation_efficiency: number }): number {
  return r.resolution_rate * 0.35 + r.compliance_score * 0.30 + r.information_capture_rate * 0.15 + r.handoff_quality * 0.10 + r.conversation_efficiency * 0.10;
}

export async function evaluateConversation(conv: ConversationResult): Promise<EvaluationScore> {
  const transcript = transcriptToString(conv.transcript);
  const { text } = await callLLM(
    MODEL_EVAL, '',
    [{ role: 'user', content: EVAL_PROMPT.replace('{transcript}', transcript) }],
    512, 'evaluation',
  );

  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(text); } catch { /* use defaults */ }

  const clamp = (v: unknown, def = 5) => Math.min(10, Math.max(0, (typeof v === 'number' ? v : def)));

  const scores: EvaluationScore = {
    conversationId: conv.conversationId,
    agentId: conv.agentId,
    promptVersion: conv.promptVersion,
    resolutionRate:         clamp(raw.resolution_rate),
    complianceScore:        clamp(raw.compliance_score),
    informationCaptureRate: clamp(raw.information_capture_rate, 0),
    handoffQuality:         clamp(raw.handoff_quality),
    conversationEfficiency: clamp(raw.conversation_efficiency),
    overallScore: 0,
    complianceViolations: Array.isArray(raw.compliance_violations) ? raw.compliance_violations as string[] : [],
    rawTranscript: transcript,
  };

  // Always recalculate — never trust LLM arithmetic
  scores.overallScore = computeWeightedScore({
    resolution_rate: scores.resolutionRate,
    compliance_score: scores.complianceScore,
    information_capture_rate: scores.informationCaptureRate,
    handoff_quality: scores.handoffQuality,
    conversation_efficiency: scores.conversationEfficiency,
  });

  await db.query(
    `INSERT INTO evaluation_scores (id, conversation_id, agent_id, prompt_version, resolution_rate, compliance_score, information_capture_rate, handoff_quality, conversation_efficiency, overall_score, compliance_violations, raw_transcript)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [uuidv4(), scores.conversationId, scores.agentId, scores.promptVersion, scores.resolutionRate, scores.complianceScore, scores.informationCaptureRate, scores.handoffQuality, scores.conversationEfficiency, scores.overallScore, JSON.stringify(scores.complianceViolations), scores.rawTranscript],
  );

  return scores;
}

export async function evaluateBatch(conversations: ConversationResult[]): Promise<EvaluationScore[]> {
  const results: EvaluationScore[] = [];
  for (const conv of conversations) {
    const score = await evaluateConversation(conv);
    results.push(score);
    process.stdout.write(`  [eval] ${conv.agentId} ${conv.persona} → overall: ${score.overallScore.toFixed(2)}\n`);
  }
  return results;
}
