import { ActivityFailure, continueAsNew, defineQuery, defineSignal, log, patched, proxyActivities, setHandler, sleep, uuid4 } from '@temporalio/workflow';
import type * as activities from './activities.js';
import { askSignalName, type GlanceInput, type Observation, type StatusReport } from './shared.js';

const tickMs = 5_000;
const visionEveryMs = 45_000;
const memoryMs = 30 * 60_000;
// At most one interruption per 3 minutes. The same kind is repeated only after 15 minutes.
const interruptionGapMs = 3 * 60_000;
const repeatMs = 15 * 60_000;

const { readActiveWindow } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10s',
  retry: { maximumAttempts: 3, initialInterval: '1s' },
});
const { captureScreen } = proxyActivities<typeof activities>({
  startToCloseTimeout: '20s',
  retry: { maximumAttempts: 3, initialInterval: '1s' },
});
// Model call: 30s timeout, 3 retries (4 attempts in total).
const { describeScreen } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30s',
  retry: { maximumAttempts: 4, initialInterval: '1s', backoffCoefficient: 2 },
});
const { decide } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10s',
  retry: { maximumAttempts: 3, initialInterval: '1s' },
});
const { beginGlance, endGlance } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5s',
  retry: { maximumAttempts: 3, initialInterval: '1s' },
});
const { showInterruption } = proxyActivities<typeof activities>({
  startToCloseTimeout: '20s',
  retry: { maximumAttempts: 2, initialInterval: '1s' },
});

export const statusQuery = defineQuery<StatusReport>('status');
// Sent by the "Ask the ghost" trigger. The next glance shows an interruption, subject to the cooldown.
export const askSignal = defineSignal(askSignalName);

// How many minutes the newest run of observations with the same key has lasted.
function streakMinutes(observations: Observation[], keyOf: (observation: Observation) => string | null): number {
  const last = observations.at(-1);
  const key = last ? keyOf(last) : null;
  if (!last || !key) return 0;
  let first = last;
  for (let i = observations.length - 1; i >= 0 && keyOf(observations[i]) === key; i -= 1) {
    first = observations[i];
  }
  return (last.at - first.at) / 60_000;
}

// "Same problem" means the same notable_kind in the same window title.
function problemKey(observation: Observation): string | null {
  const vision = observation.vision;
  return vision?.notable && vision.notable_kind ? `${vision.notable_kind}\u0000${observation.title}` : null;
}

// One sentry-trace header per glance. uuid4 is deterministic inside workflows, so replays get the same ids.
function newSentryTrace(): string {
  const traceId = uuid4().replaceAll('-', '');
  const spanId = uuid4().replaceAll('-', '').slice(0, 16);
  return `${traceId}-${spanId}-1`;
}

function errorMessage(error: unknown): string {
  const cause = error instanceof ActivityFailure ? error.cause : error;
  return cause instanceof Error ? cause.message : String(cause);
}

export async function glanceLoop(input: GlanceInput): Promise<void> {
  const startedAt = input.startedAt ?? Date.now();
  const memory = input.memory;
  let lastKey = input.lastKey;
  let lastVisionAt = input.lastVisionAt;
  let latestVision = input.latestVision;
  let lastDecision = input.lastDecision;
  let lastShownAt = input.lastShownAt ?? 0;
  let lastShownKind = input.lastShownKind ?? null;
  let askRequested = false;
  setHandler(askSignal, () => {
    askRequested = true;
  });

  setHandler(statusQuery, (): StatusReport => ({
    generation: input.generation,
    observationCount: memory.length,
    oldestAt: memory[0]?.at ?? null,
    newestAt: memory.at(-1)?.at ?? null,
    lastDecision,
    latestNotableKind: latestVision?.notable_kind ?? null,
  }));

  while (true) {
    const tickAt = Date.now();

    // Workflow history grows with every activity, so restart with a fresh history and carry the memory over.
    if (tickAt - startedAt >= input.continueAfterMs) {
      await continueAsNew<typeof glanceLoop>({
        generation: input.generation + 1,
        continueAfterMs: input.continueAfterMs,
        memory,
        lastKey,
        lastVisionAt,
        latestVision,
        lastDecision,
        lastShownAt,
        lastShownKind,
      });
    }

    const sentryTrace = newSentryTrace();
    // patched() keeps histories recorded before the glance span existed on the old path during replay.
    const glanceSpan = patched('invoke-agent-span');
    try {
      if (glanceSpan) await beginGlance(sentryTrace);
      const window = await readActiveWindow(sentryTrace);
      const key = `${window.app}\u0000${window.title}`;

      if (key !== lastKey || tickAt - lastVisionAt >= visionEveryMs) {
        const reason = key !== lastKey ? 'window changed' : 'every 45s';
        lastVisionAt = tickAt;
        try {
          latestVision = await describeScreen(await captureScreen(sentryTrace), sentryTrace);
          const notable = latestVision.notable ? ` Notable (${latestVision.notable_kind}): ${latestVision.notable}` : '';
          log.info(`vision (${reason}): ${latestVision.app}, ${latestVision.activity}. ${latestVision.detail}${notable}`);
        } catch (error) {
          log.warn(`vision failed after retries: ${errorMessage(error)}`);
        }
      }
      lastKey = key;

      memory.push({ at: tickAt, key, app: window.app, title: window.title, vision: latestVision });
      const cutoff = tickAt - memoryMs;
      while (memory.length && memory[0].at < cutoff) memory.shift();

      const decision = await decide({
        nowMs: tickAt,
        app: window.app,
        title: window.title,
        windowMinutes: streakMinutes(memory, (observation) => observation.key),
        errorMinutes: streakMinutes(memory, problemKey),
        notable: latestVision?.notable ?? null,
        notableKind: latestVision?.notable_kind ?? null,
        sentryTrace,
      });
      if (decision.kind !== lastDecision?.kind) {
        log.info(`${decision.kind.toUpperCase()}${decision.message ? ` ${decision.message}` : ''}`);
      }
      lastDecision = decision;

      // Show step. patched() keeps histories recorded before this step existed on the old path.
      if (patched('ghost-ui')) {
        const forced = askRequested;
        askRequested = false;
        const kind = decision.kind === 'quiet' ? (forced ? 'help' : null) : decision.kind;
        const changed = kind !== lastShownKind || tickAt - lastShownAt >= repeatMs;
        if (kind && (forced || changed)) {
          // "Ask the ghost" bypasses the cooldown. Automatic interruptions respect it.
          // patched() keeps histories recorded before this bypass on the old path, where a forced ask in the cooldown was skipped.
          const bypass = forced && patched('ask-bypass');
          if (!bypass && tickAt - lastShownAt < interruptionGapMs) {
            log.info('interruption skipped: under the 3 minute cooldown');
          } else {
            await showInterruption({ kind, observation: latestVision, sentryTrace, forced: bypass }).catch((error) => {
              log.warn(`show failed: ${errorMessage(error)}`);
            });
            lastShownAt = tickAt;
            lastShownKind = kind;
          }
        }
      }
    } catch (error) {
      log.warn(`tick failed: ${errorMessage(error)}`);
    }
    // Runs even after a failed tick, so the glance span is always closed.
    if (glanceSpan) {
      await endGlance(sentryTrace).catch((error) => log.warn(`closing glance span failed: ${errorMessage(error)}`));
    }

    await sleep(tickMs);
  }
}
