// Standalone DGM demonstration — no API key required.
// Shows the seeded Rule 1 blind spot being detected and self-patched.
//
// Run: pnpm exec tsx scripts/demo-dgm.ts

import { demonstrateDgm } from '../src/learning/meta-evaluator.js';
import { checkComplianceRegex, RULESET_VERSION } from '../src/compliance/compliance-checker.js';

async function main(): Promise<void> {
  // Verify the seeded flaw exists before patching
  // A prompt with no AI disclosure — should fail Rule 1 in v1.1 but passes in v1.0.
  const badPrompt = `You are a professional debt collector. This call is recorded.
If they say stop contacting me, acknowledge and end. Hardship program available.
Stay professional if abusive. Use only the last 4 digits for verification.`;

  console.log('Before DGM patch:');
  const before = checkComplianceRegex(badPrompt);
  console.log(`  Ruleset: ${RULESET_VERSION}`);
  console.log(`  Prompt without AI disclosure → passed: ${before.passed} (${before.violations.length} violations)`);
  console.log(`  Expected: passed=true (the seeded flaw — Rule 1 not enforced)\n`);

  // Run the DGM demonstration
  await demonstrateDgm();

  // Verify the fix is now live
  console.log('\nAfter DGM patch:');
  const after = checkComplianceRegex(badPrompt);
  console.log(`  Ruleset: ${RULESET_VERSION}`);
  console.log(`  Same prompt → passed: ${after.passed}`);
  if (!after.passed) {
    console.log(`  Violations caught: ${after.violations.join('\n    ')}`);
  }

  console.log('\nDGM demonstration complete. The system detected and fixed its own evaluation blind spot.');
}

main().catch((err) => { console.error(err); process.exit(1); });
