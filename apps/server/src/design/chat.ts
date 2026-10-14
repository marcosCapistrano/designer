import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { allocIds, canonicalStringify, decodeOpLog, walkDoc } from '@hub/design-model';
import type { DesignChatResult, DesignChatState, DesignEditResult, NodeSelection } from '@hub/protocol';
import type { AppRegistry } from '../apps/registry.js';
import { BuildError } from '../build/ci.js';
import type { BuildService } from '../build/service.js';
import type { ClaudeRunner } from '../claude/runner.js';
import type { WsHub } from '../ws/hub.js';
import type { SyncService } from '../sync/service.js';
import type { DesignEditing } from './editing.js';
import type { DesignChatStore } from './chat-store.js';

export interface DesignToolActions {
  getPage(pageId: string): Promise<unknown>;
  find(query: string): Promise<unknown>;
  allocate(count: number): Promise<string[]>;
  apply(ops: unknown[]): Promise<DesignEditResult>;
}
export type DesignMcpFactory = (actions: DesignToolActions) => unknown;
const toolReply = async (run: () => Promise<unknown>) => {
  try { return { content: [{ type: 'text' as const, text: JSON.stringify(await run()) }] }; }
  catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Invalid design action' }] }; }
};
export const designMcp: DesignMcpFactory = (actions) => createSdkMcpServer({ name: 'design', version: '1.0.0', tools: [
  tool('design_get_page', 'Read an imported design page and its shared components.', { pageId: z.string() }, ({ pageId }) => toolReply(() => actions.getPage(pageId))),
  tool('design_find_nodes', 'Find model node IDs by text, name or tag. Use these IDs for exact edits.', { query: z.string().max(200) }, ({ query }) => toolReply(() => actions.find(query))),
  tool('design_alloc_ids', 'Allocate collision-free IDs for new model nodes.', { count: z.number().int().min(1).max(100) }, ({ count }) => toolReply(() => actions.allocate(count))),
  tool('design_apply_ops', 'Apply exact validated operations. Wide/shared edits return a preview requiring a user tap.', { ops: z.array(z.unknown()).min(1).max(100) }, ({ ops }) => toolReply(() => actions.apply(ops))),
] });
const TOOLS = ['design_get_page','design_find_nodes','design_alloc_ids','design_apply_ops'].map((name) => `mcp__design__${name}`);

export interface DesignChatDeps {
  registry: Pick<AppRegistry, 'get'>; build: Pick<BuildService, 'withCheckout'>; sync: Pick<SyncService, 'load'>;
  editing: Pick<DesignEditing, 'prepare' | 'selection'>; runner: ClaudeRunner; store: DesignChatStore; hub: WsHub;
  dataDir: string; mcp?: DesignMcpFactory;
}
export class DesignChat {
  private readonly runs = new Map<string, AbortController>();
  private readonly ended = new Set<Promise<unknown>>();
  private closing = false;
  constructor(private readonly deps: DesignChatDeps) {}
  async state(app: string): Promise<DesignChatState> {
    if (!await this.deps.registry.get(app)) throw new BuildError('Unknown app', 404);
    return { running: this.runs.has(app), messages: this.deps.store.messages(app) };
  }
  stop(app: string): boolean { const run = this.runs.get(app); run?.abort(); return !!run; }
  async close(): Promise<void> { this.closing = true; for (const run of this.runs.values()) run.abort(); await Promise.allSettled([...this.ended]); }
  send(app: string, prompt: string, selection?: NodeSelection): Promise<DesignChatResult> {
    const text = prompt.trim();
    if (this.closing) throw new BuildError('The Hub is shutting down.', 409);
    if (!text || text.length > 20_000) throw new BuildError('Design prompt must contain 1–20,000 characters.', 400);
    const run = this.deps.build.withCheckout(app, () => this.turn(app, text, selection));
    this.ended.add(run); void run.finally(() => this.ended.delete(run)).catch(() => {});
    return run;
  }
  private message(app: string, kind: 'user' | 'assistant' | 'error', text: string) {
    const message = this.deps.store.add(app,kind,text);
    this.deps.hub.broadcast({ type: 'design.message', app, message });
  }
  private async turn(app: string, text: string, selection?: NodeSelection): Promise<DesignChatResult> {
    const entry = await this.deps.registry.get(app);
    if (!entry) throw new BuildError('Unknown app', 404);
    let saved = await this.deps.sync.load(app);
    if (!saved) throw new BuildError('Import pages first.', 409);
    if (selection) await this.deps.editing.selection(app, selection);
    if (this.closing) throw new BuildError('The Hub is shutting down.', 409);
    const controller = new AbortController();
    this.runs.set(app, controller);
    this.deps.hub.broadcast({ type: 'design.status', app, running: true });
    this.message(app, 'user', text);
    let edit: DesignEditResult | null = null, failures = 0, output = '', ok = false, error: string | undefined;
    const allocated = new Set<string>();
    const actions: DesignToolActions = {
      getPage: async (pageId) => {
        const page = Object.hasOwn(saved!.state.doc.pages, pageId) ? saved!.state.doc.pages[pageId] : undefined;
        if (!page) throw new Error('Page not found');
        return { page, components: saved!.state.doc.components, tokens: saved!.state.doc.tokens };
      },
      find: async (query) => {
        const found: unknown[] = [];
        walkDoc(saved!.state.doc, (node, container) => {
          const label = node.kind === 'text' ? node.text : node.kind === 'element' ? `${node.name ?? ''} ${node.tag} ${JSON.stringify(node.attrs)}` : `${node.name ?? ''} ${node.component} ${JSON.stringify(node.props)}`;
          if (found.length < 100 && label.toLowerCase().includes(query.toLowerCase())) found.push({ id: node.id, kind: node.kind, container });
        }); return found;
      },
      allocate: async (count) => {
        if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('Allocate 1–100 IDs');
        const ids = allocIds(saved!.state.doc, count + allocated.size).filter((id) => !allocated.has(id)).slice(0,count);
        for (const id of ids) allocated.add(id); return ids;
      },
      apply: async (raw) => {
        if (controller.signal.aborted) throw new Error('Stopped by you.');
        if (failures >= 2) throw new Error('Two edit attempts failed. Explain the problem and ask the user to refine the request.');
        if (edit) throw new Error('This turn already prepared an edit. Report its result and wait for the user.');
        try {
          if (!Array.isArray(raw) || !raw.length || raw.length > 100) throw new Error('Supply 1–100 operations');
          const decoded = decodeOpLog(raw.map((op) => JSON.stringify(op)).join('\n'));
          if (!decoded.ok) throw new Error(decoded.error);
          edit = await this.deps.editing.prepare(app, saved!, decoded.value, selection, !selection);
          if (edit.mode === 'applied') saved = (await this.deps.sync.load(app))!;
          return edit;
        } catch (error) { failures++; throw error; }
      },
    };
    try {
      const cwd = join(this.deps.dataDir, 'design-chats', app);
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      const mcp = (this.deps.mcp ?? designMcp)(actions);
      const context = { pages: Object.values(saved.state.doc.pages).map(({id,name,route}) => ({id,name,route})), selection: selection ? await this.deps.editing.selection(app, selection) : null };
      for await (const event of this.deps.runner.run({ cwd, prompt: `${text}\n\nCurrent design context:\n${canonicalStringify(context)}`, resume: this.deps.store.session(app), restrictTools: true, allowedTools: TOOLS, mcpServers: { design: mcp }, signal: controller.signal,
        systemPrompt: 'You edit only the imported Hub design model through its MCP tools. Never access files, execute commands, deploy or call other tools. Respect the selected node IDs and selected device unless the user explicitly names another device. Use one exact operation for a small single-property edit; use one ordered batch for a wider edit. Shared/wide changes are proposals requiring Apply. Never claim a preview is applied. You may make only one successful edit batch per turn. After two invalid attempts, explain the failure and ask the user. Do not guess node IDs; read/find nodes first.' })) {
        if (event.type === 'text') { const chunk = event.text.slice(0, Math.max(0, 100_000 - output.length)); output += chunk; if (chunk) this.message(app, 'assistant', chunk); }
        if (event.type === 'done') { ok = event.ok; error = event.error; if (event.sessionId) this.deps.store.setSession(app,event.sessionId); }
      }
      if (controller.signal.aborted) { ok = false; error = 'Stopped by you.'; }
      if (!ok) this.message(app, 'error', error ?? 'Claude Code could not complete the design turn.');
      return { ok, text: output, edit, ...(error ? { error } : {}) };
    } finally { this.runs.delete(app); this.deps.hub.broadcast({ type: 'design.status', app, running: false, edit }); }
  }
}
