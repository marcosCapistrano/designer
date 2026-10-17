// Design chat state: history, running status and edits from Claude's turns. Moved out of the old ChatPanel
// unchanged in behaviour, and kept DOM-free so it is testable.
import type { DesignEditResult, DesignMessage, NodeSelection } from '@hub/protocol';
import type { ApiClient } from '../../net/api.js';
import type { WsClient } from '../../net/ws.js';

export const MAX_MESSAGES = 200;
export const MAX_PROMPT = 20_000;

export function mergeMessages(previous: readonly DesignMessage[], next: readonly DesignMessage[]): DesignMessage[] {
  return [...new Map([...previous, ...next].map((m) => [m.id, m] as const)).values()].sort((a, b) => a.id - b.id).slice(-MAX_MESSAGES);
}

export type EditTag = 'applied' | 'preview';
export interface ChatState { messages: readonly DesignMessage[]; running: boolean; error: string | null; tags: ReadonlyMap<number, EditTag> }

export interface ChatStoreDeps {
  app: string;
  api: Pick<ApiClient, 'designChat' | 'sendDesign' | 'stopDesign'>;
  ws: Pick<WsClient, 'on' | 'onStatus'>;
  onResult(result: DesignEditResult): void;
}

const errorText = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback);

export function createChatStore({ app, api, ws, onResult }: ChatStoreDeps) {
  let state: ChatState = { messages: [], running: false, error: null, tags: new Map() };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<ChatState>): void => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
  let lastEdit = '';

  /** Forwards an edit once (the reply and the status message can both carry it) and tags the turn's answer. */
  const result = (edit: DesignEditResult): void => {
    const key = edit.mode === 'applied' ? edit.revision : edit.proposal.id;
    if (key === lastEdit) return;
    lastEdit = key;
    const answer = [...state.messages].reverse().find((m) => m.kind === 'assistant');
    if (answer) set({ tags: new Map(state.tags).set(answer.id, edit.mode === 'applied' ? 'applied' : 'preview') });
    onResult(edit);
  };

  function start(): () => void {
    let active = true;
    let statusSeen = false;
    const off = ws.on((message) => {
      if (message.type === 'design.message' && message.app === app) set({ messages: mergeMessages(state.messages, [message.message]) });
      if (message.type === 'design.status' && message.app === app) {
        statusSeen = true;
        set({ running: message.running });
        if (message.edit) result(message.edit);
      }
    });
    const load = (): void => {
      void api.designChat(app).then((loaded) => {
        if (!active) return;
        set({ messages: mergeMessages(state.messages, loaded.messages), ...(statusSeen ? {} : { running: loaded.running }) });
      }).catch((error) => { if (active) set({ error: errorText(error, 'Could not load Design chat.') }); });
    };
    load();
    const statusOff = ws.onStatus((status) => { if (status === 'open') { statusSeen = false; load(); } });
    return () => { active = false; off(); statusOff(); };
  }

  /** False when nothing was sent or the request failed, so the caller can keep the draft. */
  async function send(text: string, selection?: NodeSelection): Promise<boolean> {
    const prompt = text.trim();
    if (!prompt || state.running) return false;
    set({ running: true, error: null });
    try {
      const reply = await api.sendDesign(app, prompt, selection);
      if (reply.edit) result(reply.edit);
      set({ running: false, ...(reply.ok ? {} : { error: reply.error ?? 'Claude Code could not complete this request.' }) });
      return true;
    } catch (error) {
      set({ running: false, error: errorText(error, 'Design request failed.') });
      return false;
    }
  }

  async function stop(): Promise<void> {
    try { await api.stopDesign(app); } catch (error) { set({ error: errorText(error, 'Could not stop Design chat.') }); }
  }

  return {
    state: (): ChatState => state,
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); },
    start,
    send,
    stop,
  };
}

export type ChatStore = ReturnType<typeof createChatStore>;
