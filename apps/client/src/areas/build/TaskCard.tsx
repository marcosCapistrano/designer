// The task summary above the Build chat: status, branch, PR and CI, with the Merge
// and Close task actions. The actions report failures here, so the caller just throws.

import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { isOpenTask } from '@hub/protocol';
import type { BuildTask } from '@hub/protocol';
import { ApiError } from '../../net/api.js';
import { summarizeTask } from './state.js';

export interface TaskCardProps {
  task: BuildTask;
  running: boolean;
  onMerge: () => Promise<void>;
  onClose: () => Promise<void>;
}

/** The server's text for an API error; a plain line for anything else, such as a network failure. */
export function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Could not reach the hub. Try again.';
}

export function TaskCard({ task, running, onMerge, onClose }: TaskCardProps): JSX.Element {
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const summary = summarizeTask(task, running);
  const canClose = isOpenTask(task.status) && !running;

  const merge = async (): Promise<void> => {
    setMerging(true);
    setMergeError(null);
    try {
      await onMerge();
    } catch (e) {
      setMergeError(errorText(e));
    } finally {
      setMerging(false);
    }
  };

  const close = async (): Promise<void> => {
    setClosing(true);
    setCloseError(null);
    try {
      await onClose();
    } catch (e) {
      setCloseError(errorText(e));
    } finally {
      setClosing(false);
    }
  };

  return (
    <section class="task-card" data-testid="task-card">
      <div class="task-head">
        <h2 class="task-title">{task.title}</h2>
        <span class={`task-status tone-${summary.tone}`} data-testid="task-status">
          {summary.label}
        </span>
      </div>
      <div class="task-meta">
        <code class="task-branch">{task.branch}</code>
        {task.prUrl !== null && (
          <a class="task-pr" data-testid="pr-link" href={task.prUrl} target="_blank" rel="noreferrer">
            PR #{task.prNumber}
          </a>
        )}
        <span>
          CI <span data-testid="ci-state">{task.ci}</span>
        </span>
      </div>
      {task.error ? (
        <p class="task-error" data-testid="task-error">
          {task.error}
        </p>
      ) : null}
      <div class="task-actions">
        <button
          type="button"
          class="btn btn-primary"
          data-testid="merge"
          disabled={!summary.canMerge || merging}
          onClick={() => void merge()}
        >
          {merging ? 'Merging…' : 'Merge'}
        </button>
        {canClose && (
          <button
            type="button"
            class="btn"
            data-testid="close-task"
            disabled={closing}
            onClick={() => void close()}
          >
            Close task
          </button>
        )}
      </div>
      {summary.mergeHint !== null && <p class="task-hint">{summary.mergeHint}</p>}
      {mergeError !== null && (
        <p class="task-error" data-testid="merge-error">
          {mergeError}
        </p>
      )}
      {closeError !== null && (
        <p class="task-error" data-testid="close-error">
          {closeError}
        </p>
      )}
    </section>
  );
}
