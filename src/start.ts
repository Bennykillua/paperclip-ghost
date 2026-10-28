import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import type { GlanceInput, StatusReport } from './shared.js';
import { askSignalName, taskQueue, temporalAddress, workflowId } from './shared.js';

const connection = await Connection.connect({ address: temporalAddress });
const client = new Client({ connection });
const handle = client.workflow.getHandle(workflowId);

if (process.argv.includes('--ask')) {
  await handle.signal(askSignalName);
  console.log(`Sent ${askSignalName}.`);
} else if (process.argv.includes('--status')) {
  const status = await handle.query<StatusReport>('status');
  console.log(JSON.stringify(status, null, 2));
} else {
  const input: GlanceInput = {
    generation: 1,
    continueAfterMs: Number(process.env.CONTINUE_AFTER_MINUTES ?? 60) * 60_000,
    memory: [],
    lastKey: null,
    lastVisionAt: 0,
    latestVision: null,
    lastDecision: null,
  };
  try {
    await client.workflow.start('glanceLoop', { taskQueue, workflowId, args: [input] });
    console.log(`Started workflow ${workflowId}.`);
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    console.log(`Workflow ${workflowId} is already running. Attaching.`);
  }
}

await connection.close();
