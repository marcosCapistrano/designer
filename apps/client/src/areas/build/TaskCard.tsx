// The task summary above the Build chat: status, branch, PR and CI, with the Merge
// and Close task actions. The actions report failures here, so the caller just throws.

import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { isOpenTask } from '@hub/protocol';
import type { BuildTask } from '@hub/protocol';
import { errorText } from '../../net/errors.js';
import { prLink, summarizeTask } from './state.js';

export interface TaskCardProps {
  task: BuildTask;
  running: boolean;
  onMerge: () => Promise<void>;
  onClose: () => Promise<void>;
}

export function TaskCard({ task, running, onMerge, onClose }: TaskCardProps): JSX.Element {
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const summary = summarizeTask(task, running);
  const canClose = isOpenTask(task.status) && !running;
  const pr = prLink(task);
  // Merge and Close both change the task, so neither starts while the other is in flight.
  const busy = merging || closing;

  const merge = async (): Promise<void> => {
    if (busy) return;
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
    if (busy) return;
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
        {pr !== null && (
          <a class="task-pr" data-testid="pr-link" href={pr.href} target="_blank" rel="noreferrer">
            {pr.label}
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
          disabled={!summary.canMerge || busy}
          onClick={() => void merge()}
        >
          {merging ? 'Merging…' : 'Merge'}
        </button>
        {canClose && (
          <button
            type="button"
            class="btn"
            data-testid="close-task"
            disabled={busy}
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
