import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerMsg } from '@hub/protocol';
import { applyBatch } from '@hub/design-model';
import { synchronizePages, type StoredSync } from '@hub/sync';
import { FakeClaudeRunner, type FakeStep } from '../claude/fake.js';
import { openDb, type Db } from '../db.js';
import { BuildError } from '../build/ci.js';
import { DesignChat, type DesignToolActions } from './chat.js';
import { DesignChatStore } from './chat-store.js';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'hub-design-chat-'));
  const db = openDb(':memory:'); databases.push(db);
  const extracted = synchronizePages({ project: { files: { 'page.tsx': 'export default () => <main><button>Start</button></main>' } }, entries: [{ route: '/', file: 'page.tsx' }], commit: 'one' });
  if (!extracted.ok) throw new Error(JSON.stringify(extracted));
  let saved: StoredSync = { state: extracted.state, revision: 'one' };
  let actions!: DesignToolActions, locked = false;
  const messages: ServerMsg[] = [];
  const scripts: FakeStep[][] = [];
  const runner = new FakeClaudeRunner(scripts);
  const store = new DesignChatStore(db, () => 123);
  const page = Object.values(saved.state.doc.pages)[0]!;
  const node = page.root.children[0]!;
  const selection = { pageId: page.id, device: 'tablet' as const, nodeIds: [node.id] };
  const chat = new DesignChat({
    dataDir, runner, store, hub: { broadcast: (message) => { messages.push(message); } },
    registry: { get: async (name) => name === 'demo' ? { name, dir: '/untrusted/app', adopted: false, manifest: null, manifestError: null } : null },
    build: { withCheckout: async (_app, action) => { if (locked) throw new BuildError('busy',409); locked = true; try { return await action(); } finally { locked = false; } } },
    sync: { load: async () => structuredClone(saved) },
    editing: {
      selection: async (_app, selected) => ({ revision: saved.revision, targets: [], selection: selected }),
      prepare: async (_app, current, ops, selected, forcePreview) => {
        const applied = applyBatch(current.state.doc,ops);
        if (!applied.ok) throw new Error(applied.error);
        if (forcePreview || !selected) return { mode: 'preview', proposal: { id: 'preview', revision: current.revision, descriptions: ['change'], manifest: null, warnings: [] } };
        saved = { revision: 'edited', state: { ...current.state, doc: applied.value.doc, pending: [...current.state.pending,...ops] } };
        return { mode: 'applied', revision: saved.revision, warnings: [] };
      },
    },
    mcp: (next) => { actions = next; return { fake: true }; },
  });
  return { chat, runner, scripts, store, dataDir, actions: () => actions, saved: () => saved, selection, node, page, messages };
}
describe('subscription-backed restricted Design chat', () => {
  it('uses a private cwd and exact MCP tools, applies one selected edit and resumes its saved session', async () => {
    const s = await setup();
    s.scripts.push([
      async () => {
        expect(await s.actions().getPage(s.page.id)).toMatchObject({ page: { id: s.page.id } });
        expect(await s.actions().find('button')).toMatchObject([{ id: s.node.id }]);
        const first = await s.actions().allocate(2), next = await s.actions().allocate(2);
        expect(new Set([...first,...next]).size).toBe(4);
        await s.actions().apply([{ op: 'setStyle', node: s.node.id, device: 'tablet', prop: 'color', value: 'red' }]);
      },
      { type: 'text', text: 'Changed the selected button.' }, { type: 'done', ok: true, sessionId: 'session-1' },
    ]);
    expect(await s.chat.send('demo','Make the selected button red',s.selection)).toMatchObject({ ok: true, edit: { mode: 'applied' } });
    expect(s.runner.calls[0]).toMatchObject({ restrictTools: true, cwd: join(s.dataDir,'design-chats','demo'), allowedTools: ['mcp__design__design_get_page','mcp__design__design_find_nodes','mcp__design__design_alloc_ids','mcp__design__design_apply_ops'] });
    expect(s.saved().state.pending).toHaveLength(1);
    expect(s.store.session('demo')).toBe('session-1');
    s.scripts.push([{ type: 'done', ok: true, sessionId: 'session-1' }]);
    await s.chat.send('demo','What changed?');
    expect(s.runner.calls[1]!.resume).toBe('session-1');
    expect(s.messages).toMatchObject(expect.arrayContaining([{ type: 'design.status', app: 'demo', running: false, edit: { mode: 'applied', revision: 'edited', warnings: [] } }]));
    expect((await s.chat.state('demo')).messages.map((message) => message.kind)).toEqual(['user','assistant','user']);
    await s.chat.close();
  });
  it('semantic targets without a selection always produce a preview and do not mutate the snapshot', async () => {
    const s = await setup();
    s.scripts.push([async () => { await s.actions().apply([{ op: 'setStyle', node: s.node.id, device: 'base', prop: 'color', value: 'red' }]); }, { type: 'done', ok: true, sessionId: 'preview' }]);
    expect(await s.chat.send('demo','Make the button red')).toMatchObject({ edit: { mode: 'preview' } });
    expect(s.saved().state.pending).toEqual([]);
    await s.chat.close();
  });
  it('stops after two invalid edit attempts and never accepts internal restore operations', async () => {
    const s = await setup();
    s.scripts.push([async () => {
      for (let i=0;i<2;i++) await expect(s.actions().apply([{ op: 'restore', seq: 0, entries: [] }])).rejects.toThrow('internal');
      await expect(s.actions().apply([{ op: 'setName', node: s.node.id, name: 'Name' }])).rejects.toThrow('Two edit attempts');
    }, { type: 'done', ok: true, sessionId: 'invalid' }]);
    await s.chat.send('demo','Edit');
    expect(s.saved().state.pending).toEqual([]);
    await s.chat.close();
  });
  it('rejects overlapping turns and stops the subscription runner while retaining completed state', async () => {
    const s = await setup();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    s.scripts.push([async (options) => { entered(); await new Promise<void>((resolve) => options.signal!.addEventListener('abort', () => resolve(), { once: true })); }, { type: 'done', ok: true, sessionId: 'stopped' }]);
    const running = s.chat.send('demo','Long design task'); await ready;
    await expect(s.chat.send('demo','Another task')).rejects.toMatchObject({ status: 409 });
    expect(s.chat.stop('demo')).toBe(true);
    expect(await running).toMatchObject({ ok: false, error: 'Stopped by you.' });
    expect((await s.chat.state('demo')).running).toBe(false);
    expect(s.saved().state.pending).toEqual([]);
    await s.chat.close();
  });
});
