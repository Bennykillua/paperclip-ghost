import { connect } from 'node:net';
import { Client, Connection } from '@temporalio/client';

// Terminal test for the ghost. Asks the worker for lines and sends demo effects straight to the window.
const uiPort = 47831; // matches src/shared.ts
const temporalAddress = '127.0.0.1:7233';
const workflowId = 'paperclip-glance';
const askSignal = 'askGhost';

const effects = ['flee', 'splatter', 'lightning'];
const workerModes = ['line', 'suggest'];
const usage = `Usage: npm run ghost:test -- <command>
  line                 worker writes a line about the latest observation (bypasses cooldown)
  suggest              worker writes an unprompted-style suggestion about the latest notable item
  flee                 ghost flees the cursor
  splatter             red ink splatter and reform
  lightning            one soft flash with thunder (possessed mode only)
  message "<text>"     show your own text in the bubble
  all                  run every effect in turn, with a pause between them`;

function sendToGhost(message) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: uiPort });
    socket.setTimeout(2_000, () => socket.destroy(new Error('ghost socket timed out')));
    socket.once('error', (error) => reject(new Error(`no ghost is listening on 127.0.0.1:${uiPort}: ${error.message}`)));
    socket.end(`${JSON.stringify(message)}\n`, () => resolve());
  });
}

async function askWorker(mode) {
  const connection = await Connection.connect({ address: temporalAddress });
  try {
    await new Client({ connection }).workflow.getHandle(workflowId).signal(askSignal, mode);
  } finally {
    await connection.close();
  }
}

async function run(command, text) {
  if (workerModes.includes(command)) {
    await askWorker(command);
    console.log(`Asked the worker for a ${command} line. It appears within about 10 seconds.`);
  } else if (effects.includes(command)) {
    await sendToGhost({ demo: command });
    console.log(`Sent the ${command} effect.`);
  } else if (command === 'message') {
    if (!text) throw new Error('message needs text, e.g. npm run ghost:test -- message "hello"');
    await sendToGhost({ kind: 'help', text, forced: true });
    console.log('Sent your message.');
  } else {
    throw new Error(`unknown command: ${command}`);
  }
}

const [command, ...rest] = process.argv.slice(2);
if (!command) {
  console.log(usage);
  process.exit(0);
}

try {
  if (command === 'all') {
    for (const step of [...workerModes, ...effects]) {
      await run(step);
      await new Promise((resolve) => setTimeout(resolve, 8_000));
    }
    await run('message', 'Hello from the terminal.');
  } else {
    await run(command, rest.join(' '));
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
