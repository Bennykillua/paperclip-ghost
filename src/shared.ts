export const taskQueue = 'paperclip-glance';
export const workflowId = 'paperclip-glance';
// 127.0.0.1 rather than localhost: the CLI and SDK time out resolving localhost to IPv6 here.
export const temporalAddress = '127.0.0.1:7233';

export type NotableKind = 'error' | 'warning' | 'notification' | 'message';

export interface Vision {
  app: string;
  activity: string;
  detail: string;
  notable: string | null;
  notable_kind: NotableKind | null;
}

export interface WindowInfo {
  app: string;
  title: string;
}

export interface Observation {
  at: number;
  key: string;
  app: string;
  title: string;
  vision: Vision | null;
}

export interface Decision {
  kind: 'quiet' | 'help' | 'haunt';
  message?: string;
}

export interface GlanceInput {
  generation: number;
  continueAfterMs: number;
  startedAt?: number;
  memory: Observation[];
  lastKey: string | null;
  lastVisionAt: number;
  latestVision: Vision | null;
  lastDecision: Decision | null;
}

export interface StatusReport {
  generation: number;
  observationCount: number;
  oldestAt: number | null;
  newestAt: number | null;
  lastDecision: Decision | null;
  latestNotableKind: NotableKind | null;
}
