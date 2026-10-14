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

export interface ApplyStateOptions {
  /**
   * false when a source newer than this snapshot (a live build.task, or an action's reply) has already set
   * `running`, so the snapshot's own flag is stale. Default true.
   */
  running?: boolean;
}

/**
 * Applies a full snapshot from the server (on load or reconnect), merging it into what the view already shows.
 *
 * `running` is only taken from a snapshot whose task is at least as new as the one on screen. Snapshots can
 * overlap and arrive out of order; an older one that kept the newer task but copied its own `running` would
 * leave Send disabled until a remount. A snapshot with no task can only set `running` while the view has none.
 */
export function applyState(v: BuildView, s: BuildState, opts: ApplyStateOptions = {}): BuildView {
  const takesTask = s.task !== null && replacesTask(v.task, s.task);
  const current = takesTask || (s.task === null && v.task === null);
  return {
    ...v,
    loaded: true,
    running: current && opts.running !== false ? s.running : v.running,
    task: takesTask ? s.task : v.task,
    messages: mergeMessages(v.messages, s.messages),
  };
}

/**
 * Applies one live server message for `app`. Returns `v` itself when the message changes nothing: another
 * app's, a task update older than the one shown, a message already shown, or anything that is not Build data
 * (render.ready, pong). A stale build.task is ignored whole, including its `running` flag.
 */
export function applyServerMsg(v: BuildView, app: string, m: ServerMsg): BuildView {
  switch (m.type) {
    case 'build.message':
      if (m.app !== app || v.messages.some((x) => x.id === m.message.id)) return v;
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

/** Whether a Claude run owns a task in this status. The server only holds these while a run is active. */
export function isRunStatus(status: BuildTaskStatus): boolean {
  return status === 'working' || status === 'verifying' || status === 'pushing';
}

/** The pull request link to show for a task: https only, and no "#null" when the number is unknown. */
export function prLink(t: BuildTask): { href: string; label: string } | null {
  if (t.prUrl === null) return null;
  let url: URL;
  try {
    url = new URL(t.prUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  return { href: t.prUrl, label: t.prNumber === null ? 'Pull request' : `PR #${t.prNumber}` };
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
