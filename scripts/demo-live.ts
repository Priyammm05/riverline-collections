// Full pipeline demo — opens Chrome for each stage.
// Flow: Agent 1 chat UI → Voice call → Agent 3 chat UI
import dotenv from 'dotenv';
import { exec } from 'child_process';
dotenv.config();

const API = 'http://localhost:3000';

async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  RIVERLINE — FULL PIPELINE DEMO');
  console.log('  Agent 1 (chat) → Agent 2 (voice) → Agent 3 (chat)');
  console.log('═'.repeat(60));

  // ── Start workflow ──────────────────────────────────────────────────────
  const borrowerProfile = {
    borrowerId: `demo-${Date.now()}`,
    name: 'Jane Doe',
    partialAccountNumber: '4321',
    debtAmount: 12000,
    loanType: 'personal',
  };

  const startRes = await fetch(`${API}/borrowers/${borrowerProfile.borrowerId}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ borrowerProfile }),
  }).then(r => r.json()) as any;

  const workflowId: string = startRes.workflowId;
  console.log(`\nWorkflow started: ${workflowId}`);
  console.log(`Temporal UI:      http://localhost:8080\n`);

  // ── Open Agent 1 chat in Chrome ─────────────────────────────────────────
  console.log('Opening Agent 1 chat in Chrome...');
  console.log('  URL: ' + `${API}/agent1?wfId=${workflowId}`);
  console.log('\n  Chat as the borrower. When assessment is done,');
  console.log('  the page automatically moves to the voice call.\n');
  exec(`open -a "Google Chrome" "${API}/agent1?wfId=${workflowId}"`);

  // ── Watch and log pipeline stages in terminal ───────────────────────────
  console.log('─'.repeat(60));
  console.log('  TERMINAL — LIVE EXECUTION LOG');
  console.log('─'.repeat(60) + '\n');

  let lastStage = 'assessment';
  let polls = 0;

  while (polls < 180) { // watch for up to 15 minutes
    await new Promise(r => setTimeout(r, 5000));
    polls++;

    try {
      const wf = await fetch(`${API}/workflows/${workflowId}/status`).then(r => r.json()) as any;
      const outcome = wf.outcome ?? {};
      const stage = outcome.currentAgent ?? 'assessment';
      const ts = new Date().toLocaleTimeString();

      if (stage !== lastStage) {
        lastStage = stage;
        const labels: Record<string, string> = {
          assessment:        '📋 Agent 1 — Assessment',
          waiting_for_voice: '📞 Agent 2 — Voice call in progress',
          final_notice:      '⚠️  Agent 3 — Final Notice chat',
          completed:         '✅ Pipeline COMPLETE',
        };
        console.log(`[${ts}] ${labels[stage] ?? stage}`);

        if (stage === 'waiting_for_voice') {
          console.log('        Voice call page opening in Chrome...');
        }
        if (stage === 'final_notice') {
          console.log('        Agent 3 chat opening in Chrome...');
        }
        if (stage === 'completed') {
          const cost = await fetch(`${API}/cost`).then(r => r.json()) as any;
          console.log(`\n        Total LLM spend: $${cost.totalCostUsd}`);
          console.log(`        Outcome: ${JSON.stringify(outcome, null, 2)}`);
          break;
        }
      }

      if (polls % 6 === 0) {
        process.stdout.write(`[${ts}] Still watching... stage: ${stage}\n`);
      }
    } catch { /* ignore */ }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
