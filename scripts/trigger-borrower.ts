// Manually trigger one borrower workflow via the Temporal client.
// Usage:
//   pnpm run trigger
//   BORROWER_ID=test-001 pnpm run trigger

import dotenv from 'dotenv';
import { Client, Connection } from '@temporalio/client';
import { borrowerWorkflow } from '../src/temporal/workflows/borrower.workflow.js';
import type { BorrowerProfile } from '../src/types/index.js';

dotenv.config();

const TASK_QUEUE = 'riverline-collections';

const DEFAULT_PROFILE: BorrowerProfile = {
  borrowerId: process.env.BORROWER_ID ?? 'test-001',
  name: 'Jane Doe',
  partialAccountNumber: '4321',
  debtAmount: 12000,
  loanType: 'personal',
};

async function main(): Promise<void> {
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace: 'default' });

  const workflowId = `borrower-${DEFAULT_PROFILE.borrowerId}-${Date.now()}`;

  console.log(`Triggering workflow: ${workflowId}`);
  console.log(`Profile:`, DEFAULT_PROFILE);

  const handle = await client.workflow.start(borrowerWorkflow, {
    taskQueue: TASK_QUEUE,
    workflowId,
    args: [{ borrowerProfile: DEFAULT_PROFILE, maxAssessmentRetries: 3, mode: 'interactive' }],
  });

  console.log(`\nWorkflow started!`);
  console.log(`  Workflow ID : ${handle.workflowId}`);
  console.log(`  Temporal UI : http://localhost:8080/namespaces/default/workflows/${workflowId}`);
  console.log(`\nSend a chat message:`);
  console.log(`  curl -s -X POST http://localhost:3000/chat/${workflowId}/message \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -d '{"message": "Hello, I got your message"}'`);

  await connection.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
