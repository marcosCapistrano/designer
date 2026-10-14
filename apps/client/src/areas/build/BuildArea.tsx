// The Build area for one app: the task card, the chat with Claude and the composer.
// BuildSync keeps the view current (snapshot on load, catch-up on every reconnect, live messages in
// between); this component draws it and runs the user's actions.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { BuildMessage } from '@hub/protocol';
import type { ApiClient } from '../../net/api.js';
import { errorText } from '../../net/errors.js';
import type { WsClient } from '../../net/ws.js';
import { EMPTY_VIEW } from './state.js';
import { BuildSync } from './sync.js';
import type { BuildSyncSnapshot } from './sync.js';
import { TaskCard } from './TaskCard.js';
import './build.css';

/** Auto-scroll only when the list was this close to the bottom before new messages arrived. */
const STICK_PX = 80;

export interface BuildAreaProps {
  app: string;
  api: ApiClient;
  ws: WsClient;
}

function MessageBubble({ message }: { message: BuildMessage }): JSX.Element {
  return (
    <div class={`build-msg build-msg-${message.kind}`} data-testid={`msg-${message.kind}`}>
      {message.text}
    </div>
  );
}

/** One app's Build area. The parent keys it by app, so a different app is a fresh instance with fresh state. */
export function BuildArea({ app, api, ws }: BuildAreaProps): JSX.Element {
  const [snap, setSnap] = useState<BuildSyncSnapshot>({ view: EMPTY_VIEW, loadError: null });
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  /** The error of the user's own send or stop. Kept apart from snap.loadError so a refetch never wipes it. */
  const [actionError, setActionError] = useState<string | null>(null);
  const syncRef = useRef<BuildSync | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const { view, loadError } = snap;
  const shownError = actionError ?? loadError;

  useEffect(() => {
    const sync = new BuildSync({ app, api, ws, onChange: setSnap });
    syncRef.current = sync;
    sync.start();
    return () => {
      sync.stop();
      syncRef.current = null;
    };
  }, [app, api, ws]);

  // Pinned to the bottom stays pinned when the list resizes: the task card appearing or an error line
  // opening above the composer both change its height without a scroll event.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el !== null && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [view.messages, view.task, shownError]);

  const onScroll = (): void => {
    const el = listRef.current;
    if (el !== null) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
  };

  const canSend = draft.trim() !== '' && !view.running && !sending;

  const send = async (): Promise<void> => {
    const text = draft.trim();
    const sync = syncRef.current;
    if (text === '' || view.running || sending || sync === null) return;
    setSending(true);
    setActionError(null);
    try {
      const task = await api.sendBuild(app, text);
      if (syncRef.current !== sync) return;
      sync.applyTask(task);
      // Keep anything typed while the request was in flight.
      setDraft((d) => (d.trim() === text ? '' : d));
    } catch (e) {
      if (syncRef.current === sync) setActionError(errorText(e));
    } finally {
      if (syncRef.current === sync) setSending(false);
    }
  };

  const stop = async (): Promise<void> => {
    const sync = syncRef.current;
    if (sync === null) return;
    setActionError(null);
    try {
      const stopped = await api.stopBuild(app);
      // Nothing was running, so the Stop button was stale: fetch the real state.
      if (!stopped && syncRef.current === sync) sync.refresh();
    } catch (e) {
      if (syncRef.current === sync) setActionError(errorText(e));
    }
  };

  const mergeTask = async (id: number): Promise<void> => {
    const sync = syncRef.current;
    const task = await api.merge(app, id);
    if (sync !== null && syncRef.current === sync) sync.applyTask(task);
  };

  const closeTask = async (id: number): Promise<void> => {
    const sync = syncRef.current;
    const task = await api.closeTask(app, id);
    if (sync !== null && syncRef.current === sync) sync.applyTask(task);
  };

  const task = view.task;

  return (
    <section class="build-area">
      {task !== null && (
        <TaskCard
          key={task.id}
          task={task}
          running={view.running}
          onMerge={() => mergeTask(task.id)}
          onClose={() => closeTask(task.id)}
        />
      )}
      <div class="build-messages" role="log" data-testid="build-messages" ref={listRef} onScroll={onScroll}>
        {view.messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
      </div>
      <div class="build-composer">
        {shownError !== null && (
          <p class="build-error" role="alert" data-testid="build-error">
            {shownError}
          </p>
        )}
        <textarea
          class="build-input"
          data-testid="build-input"
          aria-label="Message to Claude"
          placeholder="Ask Claude to change this app…"
          rows={2}
          value={draft}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div class="build-actions">
          {actionError === null && loadError !== null && (
            <button type="button" class="btn" data-testid="build-retry" onClick={() => syncRef.current?.refresh()}>
              Retry
            </button>
          )}
          {view.running && (
            <button type="button" class="btn btn-stop" data-testid="build-stop" onClick={() => void stop()}>
              Stop
            </button>
          )}
          <button
            type="button"
            class="btn btn-primary"
            data-testid="build-send"
            disabled={!canSend}
            onClick={() => void send()}
          >
            Send
          </button>
        </div>
      </div>
    </section>
  );
}
