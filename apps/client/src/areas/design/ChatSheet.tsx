// Design chat as a bottom sheet: a bar that is always there, and the history above it when expanded.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { DEVICE_LABEL } from '@hub/protocol';
import type { DesignEditResult, DesignMessage, Device, NodeSelection } from '@hub/protocol';
import type { ApiClient } from '../../net/api.js';
import type { WsClient } from '../../net/ws.js';
import { IconButton } from '../../ui/IconButton.js';
import { HistoryIcon, MicIcon, SendIcon, StopIcon, CloseIcon } from '../../ui/icons.js';
import { MAX_PROMPT, createChatStore } from './chat-state.js';
import type { EditTag } from './chat-state.js';
import './chat.css';

export interface ChatSelection { label: string; device: Device }

export interface ChatSheetViewProps {
  messages: readonly DesignMessage[];
  running: boolean;
  error: string | null;
  tags: ReadonlyMap<number, EditTag>;
  text: string;
  expanded: boolean;
  /** The selection that will be attached to the request, or null. */
  selection: ChatSelection | null;
  disabled: boolean;
  /** Docked under the inspector instead of spanning the bottom. */
  docked: boolean;
  onText(text: string): void;
  onSend(): void;
  onStop(): void;
  onToggle(): void;
  onDetach(): void;
  onPreview(): void;
}

const TAG_LABEL: Record<EditTag, string> = { applied: 'Applied', preview: 'Preview ready' };

export function ChatSheetView(p: ChatSheetViewProps): JSX.Element {
  const canSend = !p.disabled && !p.running && p.text.trim() !== '';
  return (
    <section class={`chat-sheet${p.docked ? ' chat-sheet-docked' : ''}${p.expanded ? ' chat-sheet-open' : ''}`} aria-label="Design chat" data-testid="chat-sheet" onPointerDown={(e) => e.stopPropagation()}>
      {p.expanded && (
        <div class="chat-messages" role="log" aria-label="Design messages" data-testid="chat-messages">
          {p.messages.length === 0 && <p class="chat-empty">Ask for a change, like “make the card titles bigger on mobile”.</p>}
          {p.messages.map((m) => {
            const tag = p.tags.get(m.id);
            return (
              <div key={m.id} class={`chat-msg chat-msg-${m.kind}`} data-testid={`chat-msg-${m.id}`}>
                <p class="chat-msg-text">{m.text}</p>
                {tag && (tag === 'preview'
                  ? <button type="button" class="chat-tag chat-tag-preview" data-testid={`chat-tag-${m.id}`} onClick={p.onPreview}>{TAG_LABEL[tag]}</button>
                  : <span class="chat-tag" data-testid={`chat-tag-${m.id}`}>{TAG_LABEL[tag]}</span>)}
              </div>
            );
          })}
        </div>
      )}
      {p.error && <p class="chat-error" role="alert" data-testid="chat-error">{p.error}</p>}
      {p.selection && (
        <div class="chat-chip" data-testid="chat-chip">
          <span class="ui-mono">{p.selection.label} · {DEVICE_LABEL[p.selection.device]}</span>
          <button type="button" class="chat-chip-x" aria-label="Send without the selection" data-testid="chat-chip-detach" onClick={p.onDetach}><CloseIcon /></button>
        </div>
      )}
      <form class="chat-bar" onSubmit={(e) => { e.preventDefault(); if (canSend) p.onSend(); }}>
        <IconButton label={p.expanded ? 'Hide history' : 'Show history'} icon={<HistoryIcon />} pressed={p.expanded} onClick={p.onToggle} data-testid="chat-toggle" />
        <input
          class="ui-input chat-input"
          data-testid="chat-input"
          value={p.text}
          maxLength={MAX_PROMPT}
          placeholder={p.selection ? `Edit the selected ${p.selection.label}…` : 'Describe a design change…'}
          aria-label="Design request"
          onInput={(e) => p.onText((e as unknown as { currentTarget: { value: string } }).currentTarget.value)}
          onKeyDown={(e) => { const k = e as unknown as { key?: string; preventDefault(): void }; if (k.key === 'Enter') { k.preventDefault(); if (canSend) p.onSend(); } }}
        />
        {p.running
          ? <IconButton label="Stop" icon={<StopIcon />} onClick={p.onStop} data-testid="chat-stop" />
          : <IconButton label="Send" icon={<SendIcon />} disabled={!canSend} onClick={p.onSend} data-testid="chat-send" />}
        <IconButton label="Voice coming later" icon={<MicIcon />} disabled data-testid="mic" />
      </form>
    </section>
  );
}

export interface ChatSheetProps {
  app: string;
  api: Pick<ApiClient, 'designChat' | 'sendDesign' | 'stopDesign'>;
  ws: Pick<WsClient, 'on' | 'onStatus'>;
  selection: NodeSelection | null;
  /** What the selection is called, e.g. "h3", or null while unknown. */
  selectionLabel: string | null;
  disabled: boolean;
  docked: boolean;
  onResult(result: DesignEditResult): void;
  onBusy(busy: boolean): void;
  onPreview(): void;
}

export function ChatSheet({ app, api, ws, selection, selectionLabel, disabled, docked, onResult, onBusy, onPreview }: ChatSheetProps): JSX.Element {
  const resultRef = useRef(onResult);
  resultRef.current = onResult;
  const store = useMemo(() => createChatStore({ app, api, ws, onResult: (r) => resultRef.current(r) }), [app, api, ws]);
  const [, rerender] = useState(0);
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState(false);
  // × detaches this selection only; the next selection attaches again.
  const [detached, setDetached] = useState<NodeSelection | null>(null);
  useEffect(() => { const off = store.subscribe(() => rerender((n) => n + 1)); const stop = store.start(); return () => { off(); stop(); }; }, [store]);
  const state = store.state();
  useEffect(() => { onBusy(state.running); }, [state.running, onBusy]);
  const attached = selection && selection !== detached ? selection : null;
  return (
    <ChatSheetView
      messages={state.messages}
      running={state.running}
      error={state.error}
      tags={state.tags}
      text={text}
      expanded={expanded}
      selection={attached ? { label: selectionLabel ?? `${attached.nodeIds.length} element${attached.nodeIds.length === 1 ? '' : 's'}`, device: attached.device } : null}
      disabled={disabled}
      docked={docked}
      onText={setText}
      onSend={() => { const draft = text; setText(''); void store.send(draft, attached ?? undefined).then((sent) => { if (!sent) setText((now) => now || draft); }); }}
      onStop={() => void store.stop()}
      onToggle={() => setExpanded(!expanded)}
      onDetach={() => setDetached(selection)}
      onPreview={onPreview}
    />
  );
}
