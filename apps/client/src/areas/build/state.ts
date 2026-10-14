import type { BuildMessage, BuildState, BuildTask, BuildTaskStatus, CiState, ServerMsg } from '@hub/protocol';

/** What the Build area shows for one app: the latest task, whether Claude is running, and the chat so far. */
export interface BuildView {
  loaded: boolean;
  running: boolean;
  task: BuildTask | null;
  messages: BuildMessage[];
}

export const EMPTY_VIEW: BuildView = { loaded: false, running: false, task: null, messages: [] };

export const MAX_VIEW_MESSAGES = 1000;

export const STATUS_LABEL: Readonly<Record<BuildTaskStatus, string>> = {
  working: 'Claude is working',
  verifying: 'Running checks',
  pushing: 'Pushing',
  review: 'Pull request open',
  no_changes: 'No changes',
  failed: 'Failed',
  queued: 'Queued (usage limit)',
  merged: 'Merged',
  closed: 'Closed',
};

const REVIEW_LABEL: Readonly<Record<CiState, string>> = {
  success: 'Ready to merge',
  pending: 'Waiting for CI',
  failure: 'CI failed',
  none: 'No CI checks',
};

/** Dedupes by id, sorts ascending and keeps only the newest MAX_VIEW_MESSAGES. Never mutates its inputs. */
function mergeMessages(current: BuildMessage[], incoming: BuildMessage[]): BuildMessage[] {
  const byId = new Map<number, BuildMessage>();
  for (const m of current) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  const sorted = [...byId.values()].sort((a, b) => a.id - b.id);
  return sorted.length > MAX_VIEW_MESSAGES ? sorted.slice(sorted.length - MAX_VIEW_MESSAGES) : sorted;
}

/** A task replaces the current one when there is none, when its id is greater, or when the id is the same and updatedAt is not older. */
function replacesTask(current: BuildTask | null, incoming: BuildTask): boolean {
  if (current === null) return true;
  if (incoming.id !== current.id) return incoming.id > current.id;
  return incoming.updatedAt >= current.updatedAt;
}

/** Applies a full snapshot from the server (on load or reconnect), merging it into what the view already shows. */
export function applyState(v: BuildView, s: BuildState): BuildView {
  return {
    ...v,
    loaded: true,
    running: s.running,
    task: s.task !== null && replacesTask(v.task, s.task) ? s.task : v.task,
    messages: mergeMessages(v.messages, s.messages),
  };
}

/** Applies one live server message for `app`. Returns `v` itself when the message is for another app or is not Build data. */
export function applyServerMsg(v: BuildView, app: string, m: ServerMsg): BuildView {
  switch (m.type) {
    case 'build.message':
      if (m.app !== app) return v;
      return { ...v, messages: mergeMessages(v.messages, [m.message]) };
    case 'build.task':
      if (m.app !== app || !replacesTask(v.task, m.task)) return v;
      return { ...v, task: m.task, running: m.running };
    default:
      return v;
  }
}

/** The id of the newest message in the view, or 0 when there are none. */
export function lastMessageId(v: BuildView): number {
  return v.messages.at(-1)?.id ?? 0;
}

export interface TaskSummary {
  label: string;
  tone: 'busy' | 'ok' | 'warn' | 'error' | 'done';
  canMerge: boolean;
  mergeHint: string | null;
}

function toneOf(t: BuildTask): TaskSummary['tone'] {
  switch (t.status) {
    case 'working':
    case 'verifying':
    case 'pushing':
      return 'busy';
    case 'review':
      return t.ci === 'success' ? 'ok' : t.ci === 'failure' ? 'error' : 'warn';
    case 'queued':
      return 'warn';
    case 'failed':
      return 'error';
    case 'no_changes':
    case 'merged':
    case 'closed':
      return 'done';
  }
}

function mergeHintOf(t: BuildTask, running: boolean, canMerge: boolean): string | null {
  if (canMerge) return null;
  if (running) return 'Wait for Claude to finish.';
  if (t.status !== 'review') return null;
  switch (t.ci) {
    case 'pending':
      return 'Merge unlocks when CI is green.';
    case 'failure':
      return 'Fix CI before merging.';
    case 'none':
      return 'This repo reports no CI checks, so the Hub cannot merge it.';
    case 'success':
      return null;
  }
}

/** Label, tone and merge affordance for the task card. */
export function summarizeTask(t: BuildTask, running: boolean): TaskSummary {
  const label = t.status === 'review' ? REVIEW_LABEL[t.ci] : STATUS_LABEL[t.status];
  const canMerge = t.status === 'review' && t.ci === 'success' && !running;
  return { label, tone: toneOf(t), canMerge, mergeHint: mergeHintOf(t, running, canMerge) };
}
