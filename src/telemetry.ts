import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Sentry from '@sentry/node';

// Sentry gets timings, names and the attributes set in traced() calls. Nothing else.
// Without SENTRY_DSN nothing is sent. Each transaction is written locally instead, so the payload can be inspected.
// AI spans never carry prompts, responses or images: content recording is off below.
const dsn = process.env.SENTRY_DSN;
const previewFile = join(tmpdir(), 'paperclip-sentry-preview.jsonl');

// Drop everything Sentry adds by default that could carry screen content or machine details.
function scrub<E extends Sentry.Event>(event: E): E {
  event.contexts = event.contexts?.trace ? { trace: event.contexts.trace } : {};
  delete event.request;
  delete event.user;
  delete event.extra;
  delete event.tags;
  delete event.breadcrumbs;
  delete event.server_name;
  delete event.modules;
  delete event.sdkProcessingMetadata; // Sentry's internal objects, which can be circular
  return event;
}

// Plain JSON for the local preview. Repeated object references are written once, so cycles can't break it.
function toPlainJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'object' && item !== null) {
      if (seen.has(item)) return undefined;
      seen.add(item);
    }
    return item;
  });
}

Sentry.init({
  dsn: dsn ?? 'http://preview@127.0.0.1:9/0',
  tracesSampleRate: 1,
  debug: process.env.SENTRY_DEBUG === '1',
  traceLifecycle: 'static', // keeps one transaction per step, with child spans, so beforeSendTransaction sees them
  defaultIntegrations: false,
  dataCollection: { genAI: { inputs: false, outputs: false } }, // Sentry records AI inputs and outputs by default
  maxBreadcrumbs: 0,
  beforeBreadcrumb: () => null,
  beforeSend: (event) => scrub(event),
  beforeSendTransaction: (event) => {
    const scrubbed = scrub(event);
    if (!dsn) appendFileSync(previewFile, `${toPlainJson(scrubbed)}\n`);
    return scrubbed;
  },
});

export type TraceAttributes = Record<string, string | number>;

// Runs work inside a span that belongs to the glance trace identified by sentryTrace.
// The workflow creates that header once per glance, so all of a glance's steps share one trace id.
// Open glance spans, keyed by trace id. A step that runs in this worker while its glance is open becomes its child.
const openGlances = new Map<string, Sentry.Span>();

function traceIdOf(sentryTrace: string): string {
  return sentryTrace.split('-')[0];
}

// The invoke_agent span for one glance. Steps nest under it until endGlance closes it.
export function openGlance(sentryTrace: string): void {
  const span = Sentry.continueTrace({ sentryTrace, baggage: undefined }, () =>
    Sentry.startInactiveSpan({
      name: 'paperclip',
      op: 'gen_ai.invoke_agent',
      attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'paperclip' },
    }),
  );
  openGlances.set(traceIdOf(sentryTrace), span);
}

export function closeGlance(sentryTrace: string): void {
  const key = traceIdOf(sentryTrace);
  openGlances.get(key)?.end();
  openGlances.delete(key);
}

export function traced<T>(
  sentryTrace: string,
  name: string,
  attributes: TraceAttributes,
  work: (span: Sentry.Span) => Promise<T>,
  op?: string,
): Promise<T> {
  const parent = openGlances.get(traceIdOf(sentryTrace)) ?? null;
  return Sentry.continueTrace({ sentryTrace, baggage: undefined }, () =>
    Sentry.withActiveSpan(parent, () => Sentry.startSpan({ name, op, attributes }, (span) => work(span))),
  );
}

export { Sentry };
