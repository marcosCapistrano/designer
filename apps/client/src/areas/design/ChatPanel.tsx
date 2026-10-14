import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { DesignEditResult, DesignMessage, NodeSelection } from '@hub/protocol';
import type { ApiClient } from '../../net/api.js';
import type { WsClient } from '../../net/ws.js';
interface Props { app: string; api: ApiClient; ws: WsClient; selection: NodeSelection | null; disabled: boolean; onResult: (result: DesignEditResult) => void; onBusy: (busy: boolean) => void }
function merged(previous: DesignMessage[], next: DesignMessage[]): DesignMessage[] {
  return [...new Map([...previous,...next].map((message) => [message.id,message])).values()].sort((a,b) => a.id-b.id).slice(-200);
}
export function ChatPanel({ app, api, ws, selection, disabled, onResult, onBusy }: Props): JSX.Element {
  const [messages, setMessages] = useState<DesignMessage[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resultRef = useRef(onResult); resultRef.current = onResult;
  const lastEdit = useRef('');
  const result = (edit: DesignEditResult) => {
    const key = edit.mode === 'applied' ? edit.revision : edit.proposal.id;
    if (key !== lastEdit.current) { lastEdit.current = key; resultRef.current(edit); }
  };
  useEffect(() => { onBusy(busy); }, [busy,onBusy]);
  useEffect(() => {
    let active = true, statusSeen = false;
    const off = ws.on((message) => {
      if (message.type === 'design.message' && message.app === app) setMessages((previous) => merged(previous,[message.message]));
      if (message.type === 'design.status' && message.app === app) { statusSeen = true; setBusy(message.running); if (message.edit) result(message.edit); }
    });
    const load = () => void api.designChat(app).then((state) => { if (active) { setMessages((previous) => merged(previous,state.messages)); if (!statusSeen) setBusy(state.running); } }).catch((error) => { if (active) setError(error instanceof Error ? error.message : 'Could not load Design chat.'); });
    load();
    const statusOff = ws.onStatus((status) => { if (status === 'open') { statusSeen = false; load(); } });
    return () => { active = false; off(); statusOff(); };
  }, [app,api,ws]);
  const send = async () => {
    const prompt = text.trim(); if (!prompt || busy || disabled) return;
    setText(''); setBusy(true); setError(null);
    try {
      const reply = await api.sendDesign(app,prompt,selection ?? undefined);
      if (reply.edit) result(reply.edit);
      if (!reply.ok) setError(reply.error ?? 'Claude Code could not complete this request.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Design request failed.'); setText((draft) => draft || prompt); }
    finally { setBusy(false); }
  };
  return <section class="design-chat" aria-label="Design chat">
    <h2>Design by chat</h2>
    <div class="design-chat-messages" role="log" aria-label="Design messages">{messages.map((message) => <p key={message.id} class={`design-message design-message-${message.kind}`}>{message.text}</p>)}</div>
    <form onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <label>Design request <textarea value={text} maxLength={20_000} onInput={(event) => setText(event.currentTarget.value)} placeholder={selection ? 'Edit the selected element…' : 'Describe a design change…'} /></label>
      <button class="shell-button" disabled={busy || disabled || !text.trim()}>Send design request</button>
      <button class="shell-button" type="button" disabled={!busy} onClick={() => { void api.stopDesign(app).catch((error) => setError(String(error))); }}>Stop design chat</button>
    </form>
    {error && <p role="alert">{error}</p>}
  </section>;
}
