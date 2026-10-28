import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities.js';
import { taskQueue, temporalAddress } from './shared.js';

const connection = await NativeConnection.connect({ address: temporalAddress });
const worker = await Worker.create({
  connection,
  namespace: 'default',
  taskQueue,
  workflowsPath: fileURLToPath(new URL('./workflows.js', import.meta.url)),
  activities,
});

console.log(`Worker running on task queue "${taskQueue}". Ctrl+C to stop.`);
await worker.run();
