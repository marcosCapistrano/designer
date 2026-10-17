import { describe, expect, it, vi } from 'vitest';
import type { DesignChatResult, DesignChatState, DesignEditResult, DesignMessage, ServerMsg } from '@hub/protocol';
import { createChatStore, mergeMessages } from './chat-state.js';

const msg = (id: number, kind: DesignMessage['kind'] = 'assistant', text = `m${id}`): DesignMessage => ({ id, app: 'a', kind, text, at: id });
const applied = (revision: string): DesignEditResult => ({ mode: 'applied', revision, warnings: [] });
const preview = (id: string): DesignEditResult => ({ mode: 'preview', proposal: { id, revision: 'r', descriptions: [], manifest: null, warnings: [] } });

describe('mergeMessages', () => {
  it('de-duplicates by id, sorts by id and keeps the last 200', () => {
    expect(mergeMessages([msg(2), msg(1)], [msg(2, 'assistant', 'new'), msg(3)]).map((m) => [m.id, m.text])).toEqual([[1, 'm1'], [2, 'new'], [3, 'm3']]);
    const many = Array.from({ length: 250 }, (_, i) => msg(i + 1));
    const kept = mergeMessages([], many);
    expect(kept).toHaveLength(200);
    expect(kept[0]!.id).toBe(51);
  });
});

function setup(initial: DesignChatState = { running: false, messages: [msg(1, 'user')] }) {
  let onMsg: (m: ServerMsg) => void = () => {};
  let onStatus: (s: string) => void = () => {};
  const ws = { on: vi.fn((l: (m: ServerMsg) => void) => { onMsg = l; return () => {}; }), onStatus: vi.fn((l: (s: never) => void) => { onStatus = l as never; return () => {}; }) };
  const api = {
    designChat: vi.fn(async () => initial),
    sendDesign: vi.fn(async (): Promise<DesignChatResult> => ({ ok: true, text: 'done', edit: null })),
    stopDesign: vi.fn(async () => ({ stopped: true })),
  };
  const onResult = vi.fn();
  const store = createChatStore({ app: 'a', api, ws: ws as never, onResult });
  const stop = store.start();
  return { store, api, ws, onResult, stop, push: (m: ServerMsg) => onMsg(m), status: (s: string) => onStatus(s) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('chat store', () => {
  it('loads the history on start', async () => {
    const t = setup();
    await flush();
    expect(t.store.state().messages.map((m) => m.id)).toEqual([1]);
  });

  it('appends design.message for this app only', async () => {
    const t = setup();
    await flush();
    t.push({ type: 'design.message', app: 'a', message: msg(2) } as ServerMsg);
    t.push({ type: 'design.message', app: 'other', message: msg(3) } as ServerMsg);
    expect(t.store.state().messages.map((m) => m.id)).toEqual([1, 2]);
  });

  it('follows design.status and forwards a new edit once, tagging the latest assistant message', async () => {
    const t = setup();
    await flush();
    t.push({ type: 'design.message', app: 'a', message: msg(2) } as ServerMsg);
    t.push({ type: 'design.status', app: 'a', running: true } as ServerMsg);
    expect(t.store.state().running).toBe(true);
    t.push({ type: 'design.status', app: 'a', running: false, edit: preview('p1') } as ServerMsg);
    t.push({ type: 'design.status', app: 'a', running: false, edit: preview('p1') } as ServerMsg);
    expect(t.onResult).toHaveBeenCalledTimes(1);
    expect(t.store.state().running).toBe(false);
    expect(t.store.state().tags.get(2)).toBe('preview');
  });

  it('reloads the history when the socket reopens', async () => {
    const t = setup();
    await flush();
    t.status('open');
    await flush();
    expect(t.api.designChat).toHaveBeenCalledTimes(2);
  });

  it('sends with the selection, forwards the reply’s edit and tags it applied', async () => {
    const t = setup();
    await flush();
    t.api.sendDesign.mockImplementationOnce(async () => {
      t.push({ type: 'design.message', app: 'a', message: msg(5) } as ServerMsg);
      return { ok: true, text: 'ok', edit: applied('r2') };
    });
    const sel = { pageId: 'p', device: 'base' as const, nodeIds: ['n'] };
    expect(await t.store.send('make it red', sel)).toBe(true);
    expect(t.api.sendDesign).toHaveBeenCalledWith('a', 'make it red', sel);
    expect(t.onResult).toHaveBeenCalledWith(applied('r2'));
    expect(t.store.state().tags.get(5)).toBe('applied');
    expect(t.store.state().running).toBe(false);
  });

  it('reports a failed reply as an error, and a thrown send as false so the text can be restored', async () => {
    const t = setup();
    await flush();
    t.api.sendDesign.mockResolvedValueOnce({ ok: false, text: '', edit: null, error: 'Claude Code could not complete this request.' });
    expect(await t.store.send('x')).toBe(true);
    expect(t.store.state().error).toBe('Claude Code could not complete this request.');
    t.api.sendDesign.mockRejectedValueOnce(new Error('offline'));
    expect(await t.store.send('y')).toBe(false);
    expect(t.store.state().error).toBe('offline');
  });

  it('ignores blank text and sends nothing while running', async () => {
    const t = setup();
    await flush();
    expect(await t.store.send('   ')).toBe(false);
    t.push({ type: 'design.status', app: 'a', running: true } as ServerMsg);
    expect(await t.store.send('x')).toBe(false);
    expect(t.api.sendDesign).not.toHaveBeenCalled();
  });

  it('stops the running request', async () => {
    const t = setup();
    await flush();
    await t.store.stop();
    expect(t.api.stopDesign).toHaveBeenCalledWith('a');
  });
});
