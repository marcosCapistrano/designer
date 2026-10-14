// The Build area for one app: the task card, the chat with Claude and the composer.
// Live server messages are applied as they arrive. Each time the socket opens, the chat
// refetches everything after its newest message, so a reconnect neither drops nor repeats any.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { BuildMessage, BuildTask } from '@hub/protocol';
import type { ApiClient } from '../../net/api.js';
import type { WsClient } from '../../net/ws.js';
import { EMPTY_VIEW, applyServerMsg, applyState, lastMessageId } from './state.js';
import type { BuildView } from './state.js';
import { TaskCard, errorText } from './TaskCard.js';
import './build.css';

/** The server's default page of messages. A full page after a cursor may be followed by more. */
const PAGE_SIZE = 500;
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

export function BuildArea({ app, api, ws }: BuildAreaProps): JSX.Element {
  const [view, setView] = useState<BuildView>(EMPTY_VIEW);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const viewRef = useRef<BuildView>(EMPTY_VIEW);
  /** Bumped when the app changes, so responses for an earlier app are ignored. */
  const generation = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  /** Applies `fn` to the latest view. viewRef tracks the state, so back-to-back updates never read a stale view. */
  const update = useCallback((fn: (v: BuildView) => BuildView): void => {
    const next = fn(viewRef.current);
    viewRef.current = next;
    setView(next);
  }, []);

  useEffect(() => {
    const gen = generation.current;
    const live = (): boolean => generation.current === gen;

    viewRef.current = EMPTY_VIEW;
    setView(EMPTY_VIEW);
    setDraft('');
    setSending(false);
    setError(null);
    stickRef.current = true;

    /** Applies the server's state for `after`. With a cursor, keeps paging while the pages come back full. */
    const fetchFrom = async (after: number | undefined): Promise<void> => {
      let cursor = after;
      for (;;) {
        const state = await api.buildState(app, cursor);
        if (!live()) return;
        update((v) => applyState(v, state));
        setError(null);
        const last = state.messages.at(-1)?.id;
        if (cursor === undefined || state.messages.length < PAGE_SIZE || last === undefined || last <= cursor) return;
        cursor = last;
      }
    };

    const failed = (e: unknown): void => {
      if (live()) setError(errorText(e));
    };

    const catchUp = (): void => {
      // With no messages held yet, ask for the newest page rather than the oldest after 0.
      const last = lastMessageId(viewRef.current);
      void fetchFrom(last === 0 ? undefined : last).catch(failed);
    };

    const offMessage = ws.on((m) => update((v) => applyServerMsg(v, app, m)));
    const offStatus = ws.onStatus((s) => {
      if (s === 'open') catchUp();
    });
    void fetchFrom(undefined).catch(failed);

    return () => {
      generation.current += 1;
      offMessage();
      offStatus();
    };
  }, [app, api, ws, update]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el !== null && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [view.messages]);

  const onScroll = (): void => {
    const el = listRef.current;
    if (el !== null) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
  };

  /** Applies a task returned by an action. The live-update rule decides whether it replaces the current one. */
  const applyTask = (task: BuildTask): void => {
    update((v) => applyServerMsg(v, app, { type: 'build.task', app, task, running: v.running }));
  };

  const canSend = draft.trim() !== '' && !view.running && !sending;

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (text === '' || view.running || sending) return;
    const gen = generation.current;
    setSending(true);
    setError(null);
    try {
      const task = await api.sendBuild(app, text);
      if (generation.current !== gen) return;
      applyTask(task);
      // Keep anything typed while the request was in flight.
      setDraft((d) => (d.trim() === text ? '' : d));
    } catch (e) {
      if (generation.current === gen) setError(errorText(e));
    } finally {
      if (generation.current === gen) setSending(false);
    }
  };

  const stop = async (): Promise<void> => {
    const gen = generation.current;
    try {
      await api.stopBuild(app);
    } catch (e) {
      if (generation.current === gen) setError(errorText(e));
    }
  };

  const mergeTask = async (id: number): Promise<void> => {
    const gen = generation.current;
    const task = await api.merge(app, id);
    if (generation.current === gen) applyTask(task);
  };

  const closeTask = async (id: number): Promise<void> => {
    const gen = generation.current;
    const task = await api.closeTask(app, id);
    if (generation.current === gen) applyTask(task);
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
        {error !== null && (
          <p class="build-error" role="alert" data-testid="build-error">
            {error}
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
