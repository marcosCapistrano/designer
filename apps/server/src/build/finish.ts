import type { BuildMessageKind, BuildTask } from '@hub/protocol';
import type { AppManifest } from '@hub/protocol/manifest';
import type { PrInfo } from '../github/github.js';
import { type BuildCommand, type CommandResult, resolveBuildCommands } from './commands.js';
import { addBuildMessage, type BuildDeps, publishTask, repoRefFor } from './deps.js';
import { fixPrompt, prBody } from './naming.js';
import type { TaskPatch } from './store.js';
import { queueAfterLimit, runTurn } from './turn.js';

/** Fix attempts Claude gets for a failing build command before the task fails. */
export const MAX_FIX_ATTEMPTS = 2;

/** Output tail shown in the feed when a command still fails after its last fix attempt. */
const FAILURE_OUTPUT_TAIL = 1500;

export interface FinishInput {
  task: BuildTask;
  dir: string;
  manifest: AppManifest | null;
  signal: AbortSignal;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A branch name as the guard compares it: no refs/heads/ or heads/ prefix, and case ignored. */
function comparable(name: string): string {
  return name.trim().replace(/^(refs\/heads\/|heads\/)/, '').toLowerCase();
}

/** Statuses during which Claude or the hub is actively working on the task. */
function isRunning(status: BuildTask['status']): boolean {
  return status === 'working' || status === 'verifying' || status === 'pushing';
}

/**
 * Finishes a Build task: commits what Claude left, verifies it (each failing command gets up to
 * MAX_FIX_ATTEMPTS Claude fixes), pushes the work branch and opens or updates its pull request.
 * Returns the task's final row. Nothing is committed or pushed unless the work branch is the
 * checked-out branch and is not the repo's default branch.
 */
export async function finishTask(deps: BuildDeps, input: FinishInput): Promise<BuildTask> {
  const { dir, manifest, signal } = input;
  const repo = deps.openRepo(dir);
  let task = input.task;

  const set = (patch: TaskPatch): BuildTask => {
    task = deps.store.updateTask(task.id, patch);
    publishTask(deps, task, isRunning(task.status));
    return task;
  };
  const note = (kind: BuildMessageKind, text: string): void => {
    addBuildMessage(deps, task.app, task.id, kind, text);
  };
  const fail = (message: string): BuildTask => {
    set({ status: 'failed', error: message });
    note('error', message);
    return task;
  };

  /**
   * Why the checkout may not be committed to or pushed, or null when it may. Allowlist: the checked-out
   * branch must be the task's own build/ branch, and not the default branch or the PR base.
   */
  const blockedReason = async (): Promise<string | null> => {
    const branch = task.branch;
    if (branch.trim() === '') return 'Refusing to commit or push: the task has no work branch.';
    const current = await repo.currentBranch();
    if (current === '' || current === 'HEAD') {
      return 'Refusing to commit or push: the checkout is not on a named branch.';
    }
    if (current !== branch) return `Claude switched to branch ${current}; the work must stay on ${branch}.`;
    if (comparable(current) === comparable(await repo.defaultBranch())) {
      return `Refusing to commit or push ${current}: the hub never commits to or pushes the default branch.`;
    }
    if (comparable(current) === comparable(task.base)) {
      return `Refusing to commit or push ${current}: it is the pull request base branch.`;
    }
    if (!current.startsWith('build/')) {
      return `Refusing to commit or push ${current}: the hub only commits to build/ branches.`;
    }
    return null;
  };

  const commitLeftovers = async (): Promise<void> => {
    if (!(await repo.isDirty())) return;
    await repo.commitAll(task.title);
    note('status', 'Committed changes Claude left uncommitted.');
  };

  /**
   * Runs the commands in order. Each failure gets a Claude fix, then the checks restart from the first command.
   * Returns the task when the run ends here (failed or queued), or null when every command passes.
   */
  const verify = async (commands: BuildCommand[]): Promise<BuildTask | null> => {
    let attempt = 0;
    let rerun = true;
    while (rerun) {
      rerun = false;
      set({ status: 'verifying' });
      for (const c of commands) {
        note('status', `Running ${c.name}: ${c.cmd}`);
        const r: CommandResult = await deps.runCommand(c.cmd, { cwd: dir, signal });
        if (r.aborted) return fail('Stopped by you.');
        if (r.ok) continue;
        if (attempt === MAX_FIX_ATTEMPTS) {
          note('error', r.output.slice(-FAILURE_OUTPUT_TAIL));
          return fail(`${c.name} still fails after ${MAX_FIX_ATTEMPTS} fix attempts.`);
        }
        attempt += 1;
        note('status', `${c.name} failed; asking Claude to fix it (attempt ${attempt} of ${MAX_FIX_ATTEMPTS}).`);
        set({ status: 'working' });
        const prompt = fixPrompt(c, r);
        const turn = await runTurn(deps, {
          app: task.app,
          taskId: task.id,
          cwd: dir,
          branch: task.branch,
          prompt,
          signal,
        });
        if (turn.limited) return queueAfterLimit(deps, task, prompt, turn);
        if (!turn.ok) {
          return fail(turn.error === 'aborted' ? 'Stopped by you.' : (turn.error ?? 'Claude Code failed'));
        }
        const blocked = await blockedReason();
        if (blocked !== null) return fail(blocked);
        await commitLeftovers();
        rerun = true;
        break;
      }
    }
    return null;
  };

  const run = async (): Promise<BuildTask> => {
    const blocked = await blockedReason();
    if (blocked !== null) return fail(blocked);
    await commitLeftovers();

    if ((await repo.commitsAhead(task.base)) === 0) {
      set({ status: 'no_changes' });
      note('status', 'No code changes, so no pull request.');
      return task;
    }
    if (task.prNumber !== null && (await repo.headSha()) === task.headSha) {
      set({ status: 'review' });
      note('status', 'No new changes.');
      return task;
    }

    const commands = await resolveBuildCommands(dir, manifest);
    if (commands.length === 0) note('status', 'No typecheck or test commands found; skipped checks.');
    const stopped = await verify(commands);
    if (stopped !== null) return stopped;
    if (signal.aborted) return fail('Stopped by you.');

    const beforePush = await blockedReason();
    if (beforePush !== null) return fail(beforePush);
    // A stop that arrived during the branch check above must not be dropped: nothing is pushed after it.
    if (signal.aborted) return fail('Stopped by you.');
    set({ status: 'pushing' });
    try {
      await repo.push(task.branch);
    } catch (err) {
      return fail(`git push failed: ${errorText(err)}`);
    }
    note('status', `Pushed ${task.branch}.`);

    const github = deps.github;
    if (github === null) {
      return fail('GITHUB_TOKEN is not set: the branch was pushed but no pull request was opened.');
    }
    const ref = await repoRefFor(deps, dir);
    if (ref === null) return fail('origin is not a GitHub repository.');

    const existing: PrInfo | null = await github.findOpenPr(ref, task.branch);
    let pr: PrInfo | null = existing;
    if (pr === null) {
      try {
        pr = await github.createPr(ref, {
          head: task.branch,
          base: task.base,
          title: task.title,
          body: prBody(deps.store.userPrompts(task.id)),
        });
      } catch (err) {
        return fail(`Could not open the pull request: ${errorText(err)}`);
      }
    }

    set({
      status: 'review',
      prNumber: pr.number,
      prUrl: pr.url,
      headSha: await repo.headSha(),
      ci: 'pending',
      error: null,
    });
    note(
      'status',
      existing === null ? `Opened pull request #${pr.number}.` : `Updated pull request #${pr.number}.`,
    );
    return task;
  };

  try {
    return await run();
  } catch (err) {
    return fail(`Could not finish the task: ${errorText(err)}`);
  }
}
