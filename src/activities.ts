import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { Context } from '@temporalio/activity';
import { closeGlance, openGlance, Sentry, traced, type TraceAttributes } from './telemetry.js';
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

interface LogOptions {
  timed?: boolean;
  spanName?: string;
  op?: string;
}

// Runs one step as a span in the glance trace. Logs every failed attempt and every retry.
// Timings are logged for the slow steps only.
async function logged<T>(
  name: string,
  sentryTrace: string,
  attributes: TraceAttributes,
  work: (span: Sentry.Span) => Promise<T>,
  { timed = false, spanName = name, op }: LogOptions = {},
): Promise<T> {
  const { attempt } = Context.current().info;
  if (attempt > 1) console.log(`[retry] ${name}: attempt ${attempt}`);
  if (timed) console.log(`[start] ${name}: attempt ${attempt}`);
  const start = performance.now();
  return traced(sentryTrace, spanName, { ...attributes, 'paperclip.attempt': String(attempt) }, async (span) => {
    try {
      const result = await work(span);
      if (timed) console.log(`[timing] ${name} ${Math.round(performance.now() - start)}ms`);
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`[fail] ${name}: attempt ${attempt} failed: ${reason}`);
      span.setAttribute('paperclip.attempt', String(attempt));
      throw error;
    }
  }, op);
}

export async function beginGlance(sentryTrace: string): Promise<void> {
  openGlance(sentryTrace);
}

export async function endGlance(sentryTrace: string): Promise<void> {
  closeGlance(sentryTrace);
}

export async function readActiveWindow(sentryTrace: string): Promise<WindowInfo> {
  return logged('window read', sentryTrace, {}, async () => {
    const { stdout } = await run('osascript', ['-e', frontWindowScript]);
    const [app = '', ...titleLines] = stdout.trim().split('\n');
    return { app, title: titleLines.join('\n') };
  });
}

// Returns a file path, not image bytes: a 1280px screenshot is far too big to store in workflow history.
export async function captureScreen(sentryTrace: string): Promise<string> {
  return logged('screenshot', sentryTrace, {}, async () => {
    await mkdir(screenDir, { recursive: true });
    await run('screencapture', ['-x', rawPath]);
    await Sentry.startSpan({ name: 'resize' }, () => run('sips', ['-Z', String(maxImageSide), rawPath, '--out', resizedPath]));
    return resizedPath;
  }, { timed: true });
}

interface OllamaResponse {
  response: string;
  model?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export async function describeScreen(imagePath: string, sentryTrace: string): Promise<Vision> {
  return logged('vision', sentryTrace, {}, async (span) => {
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
    const body = await response.json() as OllamaResponse;
    const vision = JSON.parse(body.response) as Vision;
    if (!vision.notable) vision.notable_kind = null;

    // Sentry gen_ai conventions, see docs.sentry.io/product/agents/costs. Token counts come from Ollama.
    // Prompts, responses and images are never set on the span.
    const inputTokens = body.prompt_eval_count ?? 0;
    const outputTokens = body.eval_count ?? 0;
    span.setAttributes({
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': visionModel,
      'gen_ai.response.model': body.model ?? visionModel,
      'gen_ai.provider.name': 'ollama',
      'gen_ai.usage.input_tokens': inputTokens,
      'gen_ai.usage.output_tokens': outputTokens,
      'gen_ai.usage.total_tokens': inputTokens + outputTokens,
      'gen_ai.cost.total_tokens': 0, // local model, no cost
      notable_kind: vision.notable_kind ?? 'none',
    });
    return vision;
  }, { timed: true, spanName: `chat ${visionModel}`, op: 'gen_ai.chat' });
}

export interface DecideInput {
  nowMs: number;
  app: string;
  title: string;
  windowMinutes: number;
  errorMinutes: number;
  notable: string | null;
  notableKind: NotableKind | null;
  sentryTrace: string;
}

export async function decide(input: DecideInput): Promise<Decision> {
  const attributes = { notable_kind: input.notableKind ?? 'none' };
  return logged('decide', input.sentryTrace, attributes, async () => {
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
