import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { Context } from '@temporalio/activity';
import type { Decision, NotableKind, Vision, WindowInfo } from './shared.js';

const run = promisify(execFile);

const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const visionModel = 'gemma4:e2b';
const visionTimeoutMs = 30_000;
const maxImageSide = 1280;
const stuckMinutes = Number(process.env.STUCK_MINUTES ?? 20);
const hauntUntilHour = Number(process.env.HAUNT_UNTIL_HOUR ?? 5); // local hours from midnight up to this one

// Screenshots go to a fixed folder, not a per-worker temp dir, so a restarted worker can still find the file.
const screenDir = join(tmpdir(), 'paperclip-glance');
const rawPath = join(screenDir, 'screen.png');
const resizedPath = join(screenDir, 'screen-small.png');

const notableKinds: NotableKind[] = ['error', 'warning', 'notification', 'message'];
const visionSchema = {
  type: 'object',
  properties: {
    app: { type: 'string' },
    activity: { type: 'string' },
    detail: { type: 'string' },
    notable: { type: ['string', 'null'] },
    notable_kind: { type: ['string', 'null'], enum: [...notableKinds, null] },
  },
  required: ['app', 'activity', 'detail', 'notable', 'notable_kind'],
};
const visionPrompt = 'Look at this screenshot of a macOS desktop. Reply with JSON only. '
  + 'app is the main application in use. activity is what the user is doing, in under 12 words. '
  + 'detail is one short sentence about what is on screen. '
  + 'notable is a short description of any error, warning, notification or message visible, or null when nothing stands out. '
  + 'notable_kind is error, warning, notification or message to match notable, or null. '
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

// Logs every failed attempt and every retry. Timings are logged for the slow steps only.
async function logged<T>(name: string, work: () => Promise<T>, timed = false): Promise<T> {
  const { attempt } = Context.current().info;
  if (attempt > 1) console.log(`[retry] ${name}: attempt ${attempt}`);
  if (timed) console.log(`[start] ${name}: attempt ${attempt}`);
  const start = performance.now();
  try {
    const result = await work();
    if (timed) console.log(`[timing] ${name} ${Math.round(performance.now() - start)}ms`);
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`[fail] ${name}: attempt ${attempt} failed: ${reason}`);
    throw error;
  }
}

export async function readActiveWindow(): Promise<WindowInfo> {
  return logged('window read', async () => {
    const { stdout } = await run('osascript', ['-e', frontWindowScript]);
    const [app = '', ...titleLines] = stdout.trim().split('\n');
    return { app, title: titleLines.join('\n') };
  });
}

// Returns a file path, not image bytes: a 1280px screenshot is far too big to store in workflow history.
export async function captureScreen(): Promise<string> {
  return logged('screenshot', async () => {
    await mkdir(screenDir, { recursive: true });
    await run('screencapture', ['-x', rawPath]);
    await run('sips', ['-Z', String(maxImageSide), rawPath, '--out', resizedPath]);
    return resizedPath;
  }, true);
}

export async function describeScreen(imagePath: string): Promise<Vision> {
  return logged('vision call', async () => {
    const image = (await readFile(imagePath)).toString('base64');
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
    const { response: text } = await response.json() as { response: string };
    return JSON.parse(text) as Vision;
  }, true);
}

export interface DecideInput {
  nowMs: number;
  app: string;
  title: string;
  windowMinutes: number;
  errorMinutes: number;
  notable: string | null;
  notableKind: NotableKind | null;
}

export async function decide(input: DecideInput): Promise<Decision> {
  return logged('decide', async () => {
    const stuck = Math.max(input.windowMinutes, input.errorMinutes) >= stuckMinutes;
    if (stuck) {
      const why = input.errorMinutes >= input.windowMinutes && input.notable
        ? `the same ${input.notableKind} ("${input.notable}") in ${input.title || input.app} has been showing for ${Math.round(input.errorMinutes)} min`
        : `you've been on ${input.title || input.app} for ${Math.round(input.windowMinutes)} min`;
      return { kind: 'help', message: `Stuck? ${why}. Want a hand?` };
    }

    const hour = new Date(input.nowMs).getHours();
    if (hour < hauntUntilHour) {
      const time = new Date(input.nowMs).toLocaleTimeString('en-GB');
      return { kind: 'haunt', message: `It's ${time}. You're still in ${input.app}. Nobody should be awake for this.` };
    }

    return { kind: 'quiet' };
  });
}
