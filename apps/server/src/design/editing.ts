import { randomUUID } from 'node:crypto';
import { applyBatch, classifyBatch, decodeOpLog, describeOp, type DesignDoc, type DesignNode, type Op } from '@hub/design-model';
import type { NodeSelection, DesignTarget, DesignSelection, DesignEditResult } from '@hub/protocol';
import type { StoredSync, SyncState } from '@hub/sync';
import type { BuildService } from '../build/service.js';
import { BuildError } from '../build/ci.js';
import type { SyncService } from '../sync/service.js';

interface Proposal { app: string; revision: string; ops: Op[]; expires: number }
function subtree(root: DesignNode, id: string): DesignNode | null {
  if (root.id === id) return root;
  if (root.kind === 'element') for (const child of root.children) { const found = subtree(child, id); if (found) return found; }
  return null;
}
function decodeOps(value: unknown): Op[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new BuildError('Supply 1–100 design operations.', 400);
  const decoded = decodeOpLog(value.map((op) => JSON.stringify(op)).join('\n'));
  if (!decoded.ok) throw new BuildError(decoded.error, 400);
  return decoded.value;
}
function baselineDoc(state: SyncState): DesignDoc {
  const doc: DesignDoc = { meta: { version: 1, seq: state.doc.meta.seq }, pages: {}, components: {}, tokens: {} };
  for (const saved of Object.values(state.baseline.pages)) { doc.pages[saved.page.id] = structuredClone(saved.page); Object.assign(doc.components, structuredClone(saved.components ?? {})); }
  return doc;
}

export class DesignEditing {
  private readonly proposals = new Map<string, Proposal>();
  constructor(private readonly sync: Pick<SyncService, 'load' | 'save' | 'preview'>, private readonly build: Pick<BuildService, 'withCheckout'>, private readonly now = Date.now) {}
  private async saved(app: string, revision?: string): Promise<StoredSync> {
    const saved = await this.sync.load(app);
    if (!saved) throw new BuildError('Import pages first.', 409);
    if (revision !== undefined && revision !== saved.revision) throw new BuildError('Design changed. Select the element again before editing.', 409);
    return saved;
  }
  async selection(app: string, selection: NodeSelection): Promise<DesignSelection> {
    const saved = await this.saved(app);
    const page = saved.state.doc.pages[selection.pageId];
    if (!page) throw new BuildError('Page not found.', 404);
    const targets = new Map<string, DesignTarget>();
    for (const hit of selection.nodeIds) {
      const segments = hit.split('/');
      let node = subtree(page.root, segments[0]!);
      let shared = false;
      for (const id of segments.slice(1)) {
        if (node?.kind !== 'instance') { node = null; break; }
        const def = saved.state.doc.components[node.component];
        if (!def) { node = null; break; }
        const instance = node;
        node = subtree(def.root, id);
        shared = true;
        // A component root's style can be overridden on this page instance.
        if (segments.length === 2 && node === def.root) targets.set(instance.id, { ...this.target(instance, false), declaredProps: Object.fromEntries(Object.entries(def.props).map(([key, value]) => [key, instance.props[key] ?? value.default])) });
      }
      if (!node) throw new BuildError('Selection is stale. Refresh the preview and select again.', 409);
      targets.set(node.id, this.target(node, shared));
    }
    return { revision: saved.revision, selection, targets: [...targets.values()] };
  }
  private target(node: DesignNode, shared: boolean): DesignTarget {
    if (node.kind === 'text') return { id: node.id, kind: node.kind, shared, text: node.text, textNode: node.id };
    if (node.kind === 'instance') return { id: node.id, kind: node.kind, shared, component: node.component, props: node.props, style: node.style };
    const text = node.children.length === 1 && node.children[0]?.kind === 'text' ? node.children[0] : null;
    return { id: node.id, kind: node.kind, shared, tag: node.tag, attrs: node.attrs, style: node.style, ...(text ? { text: text.text, textNode: text.id } : {}) };
  }
  async edit(app: string, revision: string, raw: unknown, selection?: NodeSelection, forcePreview = false): Promise<DesignEditResult> {
    return this.build.withCheckout(app, async () => {
      const saved = await this.saved(app, revision);
      return this.prepare(app, saved, decodeOps(raw), selection, forcePreview);
    });
  }
  /** Called by design-only MCP tools while their chat already holds the checkout reservation. */
  async prepare(app: string, saved: StoredSync, ops: Op[], selection?: NodeSelection, forcePreview = false): Promise<DesignEditResult> {
    if (selection) {
      const allowed = new Set((await this.selection(app, selection)).targets.flatMap((target) => [target.id, ...(target.textNode ? [target.textNode] : [])]));
      for (const op of ops) {
        const targets = 'node' in op && typeof op.node === 'string' ? [op.node] : op.op === 'insertNode' ? [op.parent] : op.op === 'wrapNodes' ? op.nodes : [];
        if (op.op === 'moveNode') targets.push(op.parent);
        if (!targets.length || targets.some((id) => !allowed.has(id))) throw new BuildError('The edit targets an element outside the selection. Select its targets or clear the selection for a wider preview.', 400);
      }
    }
    const applied = applyBatch(saved.state.doc, ops);
    if (!applied.ok) throw new BuildError(applied.error, 400);
    if (!forcePreview && selection && classifyBatch(saved.state.doc, ops) === 'immediate') return this.commit(app, saved, ops, applied.value.doc);
    for (const [id, proposal] of this.proposals) if (proposal.expires <= this.now() || proposal.app === app) this.proposals.delete(id);
    if (this.proposals.size >= 100) throw new BuildError('Too many pending previews.', 409);
    const id = randomUUID();
    const preview = await this.sync.preview(app, applied.value.doc, false);
    this.proposals.set(id, { app, revision: saved.revision, ops: structuredClone(ops), expires: this.now() + 30 * 60_000 });
    return { mode: 'preview', proposal: { id, revision: saved.revision, descriptions: ops.map((op) => describeOp(saved.state.doc, op)), ...preview } };
  }
  async apply(app: string, id: string): Promise<DesignEditResult> {
    return this.build.withCheckout(app, async () => {
      const proposal = this.proposals.get(id);
      if (!proposal || proposal.app !== app || proposal.expires <= this.now()) throw new BuildError('Preview expired. Request it again.', 409);
      const saved = await this.saved(app, proposal.revision);
      const applied = applyBatch(saved.state.doc, proposal.ops);
      if (!applied.ok) throw new BuildError(applied.error, 400);
      const out = await this.commit(app, saved, proposal.ops, applied.value.doc);
      this.proposals.delete(id);
      return out;
    });
  }
  cancel(app: string, id: string): void { if (this.proposals.get(id)?.app === app) this.proposals.delete(id); }
  private async commit(app: string, saved: StoredSync, ops: Op[], doc: DesignDoc): Promise<DesignEditResult> {
    const state = { ...saved.state, doc, pending: [...saved.state.pending, ...ops], batchLengths: [...(saved.state.batchLengths ?? saved.state.pending.map(() => 1)), ops.length], redo: [] };
    const revision = await this.sync.save(app, state, saved.revision);
    const preview = await this.sync.preview(app, doc);
    return { mode: 'applied', revision, warnings: preview.warnings };
  }
  async history(app: string, revision: string, action: 'undo' | 'redo'): Promise<DesignEditResult> {
    return this.build.withCheckout(app, async () => {
      const saved = await this.saved(app, revision);
      const state = structuredClone(saved.state);
      const lengths = state.batchLengths ?? state.pending.map(() => 1);
      const redo = state.redo ?? [];
      if (action === 'undo') {
        const count = lengths.pop();
        if (!count) throw new BuildError('Nothing to undo.', 409);
        redo.push(state.pending.splice(state.pending.length - count));
      } else {
        const batch = redo.pop();
        if (!batch) throw new BuildError('Nothing to redo.', 409);
        state.pending.push(...batch); lengths.push(batch.length);
      }
      const replay = applyBatch(baselineDoc(state), state.pending);
      if (!replay.ok) throw new BuildError(replay.error, 409);
      state.doc = replay.value.doc;
      state.doc.meta.seq = saved.state.doc.meta.seq + 1;
      state.batchLengths = lengths; state.redo = redo;
      const next = await this.sync.save(app, state, saved.revision);
      const preview = await this.sync.preview(app, state.doc);
      return { mode: 'applied', revision: next, warnings: preview.warnings };
    });
  }
}
