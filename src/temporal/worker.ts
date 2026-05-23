import { Worker, NativeConnection } from '@temporalio/worker';
import dotenv from 'dotenv';
import * as assessmentActivities from './activities/assessment.activity.js';
import * as resolutionActivities from './activities/resolution.activity.js';
import * as finalNoticeActivities from './activities/final-notice.activity.js';
import * as chatActivities from './activities/chat.activity.js';

dotenv.config();

const TASK_QUEUE = 'riverline-collections';

async function run(): Promise<void> {
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';

  const connection = await NativeConnection.connect({ address });
  console.log(`Connected to Temporal at ${address}`);

  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve('./workflows/borrower.workflow'),
    activities: {
      ...assessmentActivities,
      ...resolutionActivities,
      ...finalNoticeActivities,
      ...chatActivities,
    },
  });

  console.log(`Worker started on task queue: ${TASK_QUEUE}`);
  await worker.run();
}

run().catch((err) => {
  console.error('Worker fatal error:', err);
  process.exit(1);
});
