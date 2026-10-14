import {
  type BuildMessage,
  type BuildMessageKind,
  type BuildTask,
  type BuildTaskStatus,
  type CiState,
  OPEN_TASK_STATUSES,
} from '@hub/protocol';
import type { Db } from '../db.js';

export type TaskPatch = Partial<
  Pick<BuildTask, 'title' | 'branch' | 'status' | 'prNumber' | 'prUrl' | 'headSha' | 'ci' | 'mergeSha' | 'error' | 'retryAt'>
> & {
  pendingPrompt?: string | null;
  /** The commit the hub last pushed for the task (kept apart from `headSha`, which follows GitHub). */
  pushedSha?: string | null;
};

const DEFAULT_MESSAGE_PAGE = 500;

/** Column for each patchable field. The names come from this fixed map; values are always bound. */
const PATCH_COLUMNS: Record<keyof TaskPatch, string> = {
  title: 'title',
  branch: 'branch',
  status: 'status',
  prNumber: 'pr_number',
  prUrl: 'pr_url',
  headSha: 'head_sha',
  ci: 'ci',
  mergeSha: 'merge_sha',
  error: 'error',
  retryAt: 'retry_at',
  pendingPrompt: 'pending_prompt',
  pushedSha: 'pushed_sha',
};

const TASK_SELECT =
  'SELECT id, app, title, branch, base, status, pr_number, pr_url, head_sha, ci, merge_sha, error, retry_at, created_at, updated_at FROM build_tasks';

const MESSAGE_SELECT = 'SELECT id, app, task_id, kind, text, created_at FROM build_messages';

interface TaskRow {
  id: number;
  app: string;
  title: string;
  branch: string;
  base: string;
  status: BuildTaskStatus;
  pr_number: number | null;
  pr_url: string | null;
  head_sha: string | null;
  ci: CiState;
  merge_sha: string | null;
  error: string | null;
  retry_at: number | null;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: number;
  app: string;
  task_id: number | null;
  kind: BuildMessageKind;
  text: string;
  created_at: number;
}

function notFound(id: number): Error {
  return new Error(`build task ${id} not found`);
}

function toTask(row: TaskRow): BuildTask {
  return {
    id: row.id,
    app: row.app,
    title: row.title,
    branch: row.branch,
    base: row.base,
    status: row.status,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    headSha: row.head_sha,
    ci: row.ci,
    mergeSha: row.merge_sha,
    error: row.error,
    retryAt: row.retry_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): BuildMessage {
  return { id: row.id, app: row.app, taskId: row.task_id, kind: row.kind, text: row.text, at: row.created_at };
}

/** Persistence for Build tasks, the per-app Claude chat session and Build messages. */
export class BuildStore {
  private readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  chatSession(app: string): string | null {
    const row = this.db.prepare<[string], { claude_session_id: string | null }>(
      'SELECT claude_session_id FROM build_chats WHERE app = ?',
    ).get(app);
    return row?.claude_session_id ?? null;
  }

  setChatSession(app: string, sessionId: string | null): void {
    this.db
      .prepare(
        'INSERT INTO build_chats (app, claude_session_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(app) DO UPDATE SET claude_session_id = excluded.claude_session_id, updated_at = excluded.updated_at',
      )
      .run(app, sessionId, this.now());
  }

  createTask(t: { app: string; title: string; branch: string; base: string }): BuildTask {
    const now = this.now();
    const result = this.db
      .prepare(
        'INSERT INTO build_tasks (app, title, branch, base, status, ci, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(t.app, t.title, t.branch, t.base, 'working', 'none', now, now);
    return this.requireTask(Number(result.lastInsertRowid));
  }

  task(id: number): BuildTask | null {
    const row = this.db.prepare<[number], TaskRow>(`${TASK_SELECT} WHERE id = ?`).get(id);
    return row ? toTask(row) : null;
  }

  /** Applies only the keys present in `patch` (undefined is ignored) and always bumps `updatedAt`. */
  updateTask(id: number, patch: TaskPatch): BuildTask {
    const assignments = ['updated_at = ?'];
    const values: unknown[] = [this.now()];
    for (const [key, column] of Object.entries(PATCH_COLUMNS) as [keyof TaskPatch, string][]) {
      const value = patch[key];
      if (value === undefined) continue;
      assignments.push(`${column} = ?`);
      values.push(value);
    }
    const result = this.db.prepare(`UPDATE build_tasks SET ${assignments.join(', ')} WHERE id = ?`).run(...values, id);
    if (result.changes === 0) throw notFound(id);
    return this.requireTask(id);
  }

  /** Newest task of the app whose status is open. */
  openTask(app: string): BuildTask | null {
    const row = this.db
      .prepare<[string, string], TaskRow>(
        `${TASK_SELECT} WHERE app = ? AND status IN (SELECT value FROM json_each(?)) ORDER BY id DESC LIMIT 1`,
      )
      .get(app, JSON.stringify(OPEN_TASK_STATUSES));
    return row ? toTask(row) : null;
  }

  /** The newest task of the app that works on `branch`, whatever its status, or null when none does. */
  taskForBranch(app: string, branch: string): BuildTask | null {
    const row = this.db
      .prepare<[string, string], TaskRow>(`${TASK_SELECT} WHERE app = ? AND branch = ? ORDER BY id DESC LIMIT 1`)
      .get(app, branch);
    return row ? toTask(row) : null;
  }

  /** Newest task of the app regardless of status. */
  latestTask(app: string): BuildTask | null {
    const row = this.db.prepare<[string], TaskRow>(`${TASK_SELECT} WHERE app = ? ORDER BY id DESC LIMIT 1`).get(app);
    return row ? toTask(row) : null;
  }

  /** Tasks in any of the given statuses, ascending id. */
  tasksWithStatus(statuses: readonly BuildTaskStatus[]): BuildTask[] {
    if (statuses.length === 0) return [];
    return this.db
      .prepare<[string], TaskRow>(`${TASK_SELECT} WHERE status IN (SELECT value FROM json_each(?)) ORDER BY id ASC`)
      .all(JSON.stringify(statuses))
      .map(toTask);
  }

  pendingPrompt(taskId: number): string | null {
    const row = this.db
      .prepare<[number], { pending_prompt: string | null }>('SELECT pending_prompt FROM build_tasks WHERE id = ?')
      .get(taskId);
    return row?.pending_prompt ?? null;
  }

  /** The commit the hub last pushed for the task, or null when it has not pushed yet. */
  pushedSha(taskId: number): string | null {
    const row = this.db
      .prepare<[number], { pushed_sha: string | null }>('SELECT pushed_sha FROM build_tasks WHERE id = ?')
      .get(taskId);
    return row?.pushed_sha ?? null;
  }

  addMessage(m: { app: string; taskId: number | null; kind: BuildMessageKind; text: string }): BuildMessage {
    const at = this.now();
    const result = this.db
      .prepare('INSERT INTO build_messages (app, task_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(m.app, m.taskId, m.kind, m.text, at);
    return { id: Number(result.lastInsertRowid), app: m.app, taskId: m.taskId, kind: m.kind, text: m.text, at };
  }

  /**
   * With `afterId`: the first `limit` messages with id > afterId, ascending.
   * Without it: the newest `limit` messages, ascending.
   */
  messages(app: string, afterId?: number, limit = DEFAULT_MESSAGE_PAGE): BuildMessage[] {
    const rows =
      afterId === undefined
        ? this.db
            .prepare<[string, number], MessageRow>(
              `SELECT * FROM (${MESSAGE_SELECT} WHERE app = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`,
            )
            .all(app, limit)
        : this.db
            .prepare<[string, number, number], MessageRow>(
              `${MESSAGE_SELECT} WHERE app = ? AND id > ? ORDER BY id ASC LIMIT ?`,
            )
            .all(app, afterId, limit);
    return rows.map(toMessage);
  }

  /** Text of the task's user messages, ascending. */
  userPrompts(taskId: number): string[] {
    return this.db
      .prepare<[number, string], { text: string }>('SELECT text FROM build_messages WHERE task_id = ? AND kind = ? ORDER BY id ASC')
      .all(taskId, 'user')
      .map((row) => row.text);
  }

  private requireTask(id: number): BuildTask {
    const task = this.task(id);
    if (!task) throw notFound(id);
    return task;
  }
}
