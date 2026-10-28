import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

const run = promisify(execFile);

const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const visionModel = 'gemma4:e2b';
const tickMs = 5_000;
const visionEveryMs = 45_000;
const visionTimeoutMs = 30_000;
const memoryMs = 30 * 60_000;
const stuckMinutes = Number(process.env.STUCK_MINUTES ?? 20);
const hauntUntilHour = Number(process.env.HAUNT_UNTIL_HOUR ?? 5); // local hours from midnight up to this one
const maxImageSide = 1280;

const visionSchema = {
  type: 'object',
  properties: {
    app: { type: 'string' },
    activity: { type: 'string' },
    detail: { type: 'string' },
    notable: { type: ['string', 'null'] },
  },
  required: ['app', 'activity', 'detail', 'notable'],
};
const visionPrompt = 'Look at this screenshot of a macOS desktop. Reply with JSON only. '
  + 'app is the main application in use. activity is what the user is doing, in under 12 words. '
  + 'detail is one short sentence about what is on screen. '
  + 'notable is any error, warning or unusual thing visible, or null when nothing stands out. '
  + 'Describe only what is visible.';

const frontWindowScript = [
  'tell application "System Events"',
  '  set p to first application process whose frontmost is true',
  '  set appName to name of p',
  '  set winTitle to ""',
  '  try',
  '    set winTitle to name of front window of p',
  '  end try',
  '  return appName & linefeed & winTitle',
  'end tell',
].join('\n');

const observations = []; // one per tick, pruned to the last 30 minutes
let lastKey = null;
let lastVisionAt = -Infinity;
let latestVision = null;
let lastDecision = null;

function timestamp(now) {
  return new Date(now).toLocaleTimeString('en-GB');
}

function ms(duration) {
  return `${Math.round(duration)}ms`;
}

async function readActiveWindow() {
  const { stdout } = await run('osascript', ['-e', frontWindowScript]);
  const [app = '', ...titleLines] = stdout.trim().split('\n');
  return { app, title: titleLines.join('\n') };
}

async function captureScreen(dir) {
  const path = join(dir, 'screen.png');
  const resized = join(dir, 'screen-small.png');

  const screenshotStart = performance.now();
  await run('screencapture', ['-x', path]);
  const screenshotMs = performance.now() - screenshotStart;

  const resizeStart = performance.now();
  await run('sips', ['-Z', String(maxImageSide), path, '--out', resized]);
  const resizeMs = performance.now() - resizeStart;

  const image = (await readFile(resized)).toString('base64');
  return { image, screenshotMs, resizeMs };
}

async function lookAtScreen(image) {
  const response = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: visionModel,
      prompt: visionPrompt,
      images: [image],
      format: visionSchema,
      stream: false,
      think: false,
      options: { temperature: 0, num_predict: 300 },
    }),
    signal: AbortSignal.timeout(visionTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${visionModel} request failed: ${response.status} ${await response.text()}`);
  }
  const { response: text } = await response.json();
  return JSON.parse(text);
}

// Only a non-empty notable value counts. The model returns null when nothing stands out.
function notableKey(vision) {
  return vision?.notable?.trim().toLowerCase() || null;
}

function remember(observation) {
  observations.push(observation);
  const cutoff = observation.at - memoryMs;
  while (observations.length && observations[0].at < cutoff) observations.shift();
}

// How many minutes the newest run of observations with the same key has lasted.
function streakMinutes(keyOf) {
  const last = observations.at(-1);
  const key = last && keyOf(last);
  if (!key) return 0;
  let first = last;
  for (let i = observations.length - 1; i >= 0 && keyOf(observations[i]) === key; i -= 1) {
    first = observations[i];
  }
  return (last.at - first.at) / 60_000;
}

function decide(now) {
  const last = observations.at(-1);
  if (!last) return { kind: 'quiet' };

  const windowMinutes = streakMinutes((observation) => observation.key);
  const errorMinutes = streakMinutes((observation) => notableKey(observation.vision));
  const stuck = Math.max(windowMinutes, errorMinutes) >= stuckMinutes;
  if (stuck) {
    const notable = notableKey(latestVision);
    const why = errorMinutes >= windowMinutes && notable
      ? `the same problem ("${latestVision.notable.trim()}") has been showing for ${Math.round(errorMinutes)} min`
      : `you've been on ${last.title || last.app} for ${Math.round(windowMinutes)} min`;
    return { kind: 'help', message: `Stuck? ${why}. Want a hand?` };
  }

  const hour = new Date(now).getHours();
  if (hour < hauntUntilHour) {
    return { kind: 'haunt', message: `It's ${timestamp(now)}. You're still in ${last.app}. Nobody should be awake for this.` };
  }

  return { kind: 'quiet' };
}

async function tick(dir) {
  const now = Date.now();

  const windowStart = performance.now();
  const window = await readActiveWindow();
  const windowMs = performance.now() - windowStart;
  const key = `${window.app}\u0000${window.title}`;

  if (key !== lastKey || now - lastVisionAt >= visionEveryMs) {
    const reason = key !== lastKey ? 'window changed' : 'every 45s';
    lastVisionAt = now;
    try {
      const { image, screenshotMs, resizeMs } = await captureScreen(dir);

      const modelStart = performance.now();
      latestVision = await lookAtScreen(image);
      const modelMs = performance.now() - modelStart;

      console.log(`[${timestamp(now)}] timings: window ${ms(windowMs)}, screenshot ${ms(screenshotMs)}, resize ${ms(resizeMs)}, model ${ms(modelMs)}`);
      console.log(`[${timestamp(now)}] vision (${reason}): ${latestVision.app}, ${latestVision.activity}. ${latestVision.detail}${latestVision.notable ? ` Notable: ${latestVision.notable}` : ''}`);
    } catch (error) {
      const reason = error.name === 'TimeoutError' ? `model timed out after ${visionTimeoutMs / 1000}s` : error.message;
      console.log(`[${timestamp(now)}] vision failed: ${reason}`);
    }
  }
  lastKey = key;

  remember({ at: now, key, app: window.app, title: window.title, vision: latestVision });

  const decision = decide(now);
  if (decision.kind !== lastDecision?.kind) {
    const text = decision.message ? ` ${decision.message}` : '';
    console.log(`[${timestamp(now)}] ${decision.kind.toUpperCase()}${text}`);
  }
  lastDecision = decision;
}

const tempDir = await mkdtemp(join(tmpdir(), 'paperclip-glance-'));
const cleanUp = async () => {
  await rm(tempDir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', cleanUp);
process.on('SIGTERM', cleanUp);

console.log(`Glancing every ${tickMs / 1000}s with ${visionModel}. Stuck after ${stuckMinutes} min. Ctrl+C to stop.`);

while (true) {
  try {
    await tick(tempDir);
  } catch (error) {
    console.log(`[${timestamp(Date.now())}] window read failed: ${error.message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, tickMs));
}
