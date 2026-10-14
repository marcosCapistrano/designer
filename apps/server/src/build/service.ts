import { type BuildState, type BuildTask, type BuildTaskStatus, isOpenTask } from '@hub/protocol';
import type { AppEntry } from '../apps/registry.js';
import { BuildError, mergeTask, pollCi, refreshCi } from './ci.js';
import { addBuildMessage, type BuildDeps, publishTask } from './deps.js';
import { finishTask } from './finish.js';
import { branchSlug, prTitle } from './naming.js';
import { queueAfterLimit, runTurn } from './turn.js';

/** Longest message, in characters, that the Build chat accepts. */
export const MAX_MESSAGE_CHARS = 20_000;

const RESTART_ERROR = 'Interrupted because the Hub restarted. Send a message to continue.';
const RETRY_FALLBACK_PROMPT = 'Continue where you left off.';

/** Statuses a task holds only while a run is working on it. */
const IN_FLIGHT: readonly BuildTaskStatus[] = ['working', 'verifying', 'pushing'];

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One app's active run: its abort handle and a promise that settles once the run has ended. */
interface Run {
  controller: AbortController;
  ended: Promise<void>;
  end: () => void;
}

/** The task a message continues or starts, and whether this message created it. */
interface Prepared {
  task: BuildTask;
  created: boolean;
}

/**
 * One Build chat per app: a message runs Claude on the app's open task (or a new `build/` branch),
 * finishes the task (verify, commit, push, PR), tracks CI, and merges. At most one run per app.
 */
export class BuildService {
  private readonly deps: BuildDeps;
  private readonly runs = new Map<string, Run>();
  /** CI refreshes in flight, by task id, so concurrent callers share one call. */
  private readonly refreshes = new Map<number, Promise<void>>();
  /** The poll in flight, so refreshes and polls never read one task's CI at the same time. */
  private polling: Promise<void> | null = null;

  constructor(deps: BuildDeps) {
    this.deps = deps;
  }

  isRunning(app: string): boolean {
    return this.runs.has(app);
  }

  latestStatus(app: string): BuildTaskStatus | null {
    return this.deps.store.latestTask(app)?.status ?? null;
  }

  /**
   * The app's Build snapshot. A review task whose CI is still pending is refreshed from GitHub first
   * (the poller gives up on a long-pending head), unless a run is in progress.
   */
  async state(app: string, after?: number): Promise<BuildState> {
    if ((await this.deps.registry.get(app)) === null) throw new BuildError('Unknown app', 404);
    await this.refreshPendingCi(app);
    return {
      running: this.isRunning(app),
      task: this.deps.store.latestTask(app),
      messages: this.deps.store.messages(app, after),
    };
  }

  /** Validates the message, prepares git, and returns once Claude is running in the background. */
  async send(app: string, text: string): Promise<BuildTask> {
    const prompt = text.trim();
    if (prompt === '') throw new BuildError('Message is empty.', 400);
    if (prompt.length > MAX_MESSAGE_CHARS) {
      throw new BuildError(`Message is longer than ${MAX_MESSAGE_CHARS} characters.`, 400);
    }
    const entry = await this.deps.registry.get(app);
    if (entry === null) throw new BuildError('Unknown app', 404);
    if (this.isRunning(app)) {
      throw new BuildError('Claude is already working on this app. Wait or tap Stop.', 409);
    }

    // Reserved before the next await, so a second send cannot slip in while git is prepared.
    const run = this.reserve(app);
    let prepared: Prepared | null = null;
    let launched = false;
    try {
      prepared = await this.prepare(app, entry, prompt);
      const { task } = prepared;
      addBuildMessage(this.deps, app, task.id, 'user', prompt);
      publishTask(this.deps, task, true);
      this.launch(app, entry, task, prompt, run);
      launched = true;
      return this.requireTask(task.id);
    } catch (err) {
      if (prepared?.created === true) this.abandon(prepared.task.id, err);
      throw err;
    } finally {
      if (!launched) this.release(app, run);
    }
  }

  /** Aborts the app's run. Returns whether there was one. */
  stop(app: string): boolean {
    const run = this.runs.get(app);
    if (run === undefined) return false;
    run.controller.abort();
    return true;
  }

  async close(app: string, taskId: number): Promise<BuildTask> {
    const task = this.deps.store.task(taskId);
    if (task === null || task.app !== app) throw new BuildError('Task not found', 404);
    if (this.isRunning(app)) throw new BuildError('Claude is still working on this app.', 409);
    if (task.status === 'merged' || task.status === 'closed') return task;
    const closed = this.deps.store.updateTask(task.id, { status: 'closed', error: null });
    addBuildMessage(this.deps, app, task.id, 'status', 'Task closed. The next message starts a new branch.');
    publishTask(this.deps, closed, false);
    return closed;
  }

  merge(app: string, taskId: number): Promise<BuildTask> {
    return mergeTask(this.deps, app, taskId, this.isRunning(app));
  }

  /** Resolves once the app has no run: its Claude turn, finish and bookkeeping are all done. */
  async idle(app: string): Promise<void> {
    for (let run = this.runs.get(app); run !== undefined; run = this.runs.get(app)) {
      await run.ended;
    }
  }

  /** Aborts every run (including one still preparing git) and waits for each to end. */
  async stopAll(): Promise<void> {
    const runs = [...this.runs.values()];
    for (const run of runs) run.controller.abort();
    await Promise.all(runs.map((run) => run.ended));
  }

  /** Fails the tasks a restart interrupted. Returns how many. Tasks of a running app are left alone. */
  recover(): number {
    let count = 0;
    for (const task of this.deps.store.tasksWithStatus(IN_FLIGHT)) {
      if (this.isRunning(task.app)) continue;
      this.failTask(task.id, RESTART_ERROR, false);
      count += 1;
    }
    return count;
  }

  /** Restarts every queued task whose retry time has come. Returns how many runs started. */
  async retryQueued(): Promise<number> {
    let started = 0;
    for (const queued of this.deps.store.tasksWithStatus(['queued'])) {
      if (queued.retryAt === null || queued.retryAt > this.deps.now()) continue;
      if (this.isRunning(queued.app)) continue;
      try {
        if (await this.retry(queued)) started += 1;
      } catch (err) {
        console.warn(`Retrying queued task ${queued.id} failed: ${errorText(err)}`);
      }
    }
    return started;
  }

  /**
   * Polls CI of every idle review task. It starts after the refreshes already in flight (and any earlier poll)
   * have settled, and refreshes requested while it runs wait for it, so one green PR is announced once.
   */
  pollCi(): Promise<void> {
    const before = [this.polling, ...this.refreshes.values()];
    const poll: Promise<void> = (async () => {
      await Promise.allSettled(before);
      await pollCi(this.deps, (app) => this.isRunning(app));
    })().finally(() => {
      if (this.polling === poll) this.polling = null;
    });
    this.polling = poll;
    return poll;
  }

  /**
   * Refreshes a task's CI from GitHub, sharing the call with concurrent callers and waiting out a poll.
   * `needed` is checked on the stored task once the refresh may start, so a task a poll just brought up
   * to date is not read again.
   */
  private refreshOnce(taskId: number, needed: (task: BuildTask) => boolean): Promise<void> {
    const flying = this.refreshes.get(taskId);
    if (flying !== undefined) return flying;
    const flight: Promise<void> = (async () => {
      if (this.polling !== null) await this.polling.catch(() => undefined);
      const task = this.deps.store.task(taskId);
      if (task !== null && needed(task)) await refreshCi(this.deps, taskId);
    })().finally(() => {
      this.refreshes.delete(taskId);
    });
    this.refreshes.set(taskId, flight);
    return flight;
  }

  private reserve(app: string): Run {
    let end!: () => void;
    const ended = new Promise<void>((resolve) => {
      end = resolve;
    });
    const run: Run = { controller: new AbortController(), ended, end };
    this.runs.set(app, run);
    return run;
  }

  /** Frees the app, then wakes whoever waits on `idle`. */
  private release(app: string, run: Run): void {
    if (this.runs.get(app) === run) this.runs.delete(app);
    run.end();
  }

  private requireTask(id: number): BuildTask {
    const task = this.deps.store.task(id);
    if (task === null) throw new Error(`build task ${id} not found`);
    return task;
  }

  /** Runs `step`; a failure is logged, never thrown, so cleanup after it still happens. */
  private guarded(what: string, step: () => void): void {
    try {
      step();
    } catch (err) {
      console.warn(`Build ${what} failed: ${errorText(err)}`);
    }
  }

  private failTask(taskId: number, message: string, running: boolean): void {
    const failed = this.deps.store.updateTask(taskId, { status: 'failed', error: message });
    addBuildMessage(this.deps, failed.app, taskId, 'error', message);
    publishTask(this.deps, failed, running);
  }

  /** Fails a task this send created but could not start, so it is not left in `working`. */
  private abandon(taskId: number, err: unknown): void {
    this.guarded(`cleanup of task ${taskId}`, () => this.failTask(taskId, errorText(err), false));
  }

  /**
   * Ends a task that never got its work branch. It is closed, not failed: a failed task would be continued
   * by the next message, which would try to check out a branch that does not exist.
   */
  private discard(taskId: number, err: unknown): void {
    this.guarded(`cleanup of task ${taskId}`, () => {
      const closed = this.deps.store.updateTask(taskId, { status: 'closed', error: null });
      addBuildMessage(this.deps, closed.app, taskId, 'error', errorText(err));
      publishTask(this.deps, closed, false);
    });
  }

  /** Reads a review task's CI from GitHub when it is still pending and no run is in progress. */
  private async refreshPendingCi(app: string): Promise<void> {
    if (this.isRunning(app)) return;
    try {
      const open = this.deps.store.openTask(app);
      if (open?.status === 'review' && open.ci === 'pending') {
        await this.refreshOnce(open.id, (task) => task.status === 'review' && task.ci === 'pending');
      }
    } catch (err) {
      console.warn(`Build state refresh for ${app} failed: ${errorText(err)}`);
    }
  }

  /** Finds the task a message continues, or creates one on a fresh branch, with git ready for Claude. */
  private async prepare(app: string, entry: AppEntry, prompt: string): Promise<Prepared> {
    const { store } = this.deps;
    let task = store.openTask(app);
    if (task?.status === 'review') {
      await this.refreshOnce(task.id, () => true);
      task = store.task(task.id);
    }
    if (task !== null && !isOpenTask(task.status)) task = null;

    const git = async <T>(step: () => Promise<T>): Promise<T> => {
      try {
        return await step();
      } catch (err) {
        throw new BuildError(`Git: ${errorText(err)}`, 409);
      }
    };
    const repo = this.deps.openRepo(entry.dir);

    if (task !== null) {
      const { branch } = task;
      if ((await git(() => repo.currentBranch())) !== branch) await git(() => repo.checkout(branch));
      return { task, created: false };
    }

    const current = await git(() => repo.currentBranch());
    if (await git(() => repo.isDirty())) {
      throw new BuildError(`The checkout has uncommitted changes on ${current}. Commit or discard them first.`, 409);
    }
    await git(() => repo.fetch());
    const base = await git(() => repo.defaultBranch());
    const created = store.createTask({ app, title: prTitle(prompt), branch: '', base });
    try {
      const branch = `build/${branchSlug(prompt, created.id)}`;
      const named = store.updateTask(created.id, { branch });
      await git(() => repo.createBranchFrom(branch, base));
      return { task: named, created: true };
    } catch (err) {
      this.discard(created.id, err);
      throw err;
    }
  }

  /** Starts the background work for a reserved run. `work` never rejects. */
  private launch(app: string, entry: AppEntry, task: BuildTask, prompt: string, run: Run): void {
    void this.work(app, entry, task, prompt, run);
  }

  /** Restarts one queued task. Returns whether a run started. */
  private async retry(queued: BuildTask): Promise<boolean> {
    const entry = await this.deps.registry.get(queued.app);
    if (entry === null) return false;
    // Read again: the task may have been closed, or the app started, while the registry answered.
    const task = this.deps.store.task(queued.id);
    if (task?.status !== 'queued' || this.isRunning(task.app)) return false;

    const run = this.reserve(task.app);
    let launched = false;
    try {
      try {
        await this.deps.openRepo(entry.dir).checkout(task.branch);
      } catch (err) {
        this.failTask(task.id, `Git: ${errorText(err)}`, false);
        return false;
      }
      addBuildMessage(this.deps, task.app, task.id, 'status', 'Retrying after the usage limit.');
      const prompt = this.deps.store.pendingPrompt(task.id) ?? RETRY_FALLBACK_PROMPT;
      this.launch(task.app, entry, task, prompt, run);
      launched = true;
      return true;
    } finally {
      if (!launched) this.release(task.app, run);
    }
  }

  /**
   * One Claude turn for the task, then finish it. Whatever happens, the task leaves `working`,
   * the app is released and the final (not running) state is broadcast. Never rejects.
   */
  private async work(app: string, entry: AppEntry, task: BuildTask, prompt: string, run: Run): Promise<void> {
    const { store } = this.deps;
    try {
      const started = store.updateTask(task.id, {
        status: 'working',
        error: null,
        retryAt: null,
        pendingPrompt: null,
      });
      publishTask(this.deps, started, true);

      const turn = await runTurn(this.deps, {
        app,
        taskId: task.id,
        cwd: entry.dir,
        branch: started.branch,
        prompt,
        signal: run.controller.signal,
      });
      if (turn.limited) {
        queueAfterLimit(this.deps, this.requireTask(task.id), prompt, turn);
      } else if (!turn.ok) {
        const error = turn.error === 'aborted' ? 'Stopped by you.' : (turn.error ?? 'Claude Code failed');
        this.failTask(task.id, error, true);
      } else {
        await finishTask(this.deps, {
          task: this.requireTask(task.id),
          dir: entry.dir,
          manifest: entry.manifest,
          signal: run.controller.signal,
        });
      }
    } catch (err) {
      this.guarded(`failure handling for task ${task.id}`, () =>
        this.failTask(task.id, `Unexpected error: ${errorText(err)}`, true),
      );
    } finally {
      this.release(app, run);
      this.guarded(`final broadcast for task ${task.id}`, () =>
        publishTask(this.deps, this.requireTask(task.id), false),
      );
    }
  }
}
