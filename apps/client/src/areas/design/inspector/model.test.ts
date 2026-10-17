import { describe, expect, it, vi } from 'vitest';
import type { DesignEditResult, DesignSelection, NodeSelection } from '@hub/protocol';
import { ApiError } from '../../../net/api.js';
import { createInspectorModel } from './model.js';

const sel = (id: string, device: NodeSelection['device'] = 'base'): NodeSelection => ({ pageId: 'p', device, nodeIds: [id] });
const info = (id: string, revision = 'r1', device: NodeSelection['device'] = 'base'): DesignSelection => ({
  revision,
  selection: sel(id, device),
  targets: [{ id, kind: 'element', shared: false, tag: 'h3', style: { base: {} } }, { id: `${id}-c`, kind: 'instance', shared: true, component: 'Card' }],
});

function deferred<T>() {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup() {
  const loads: Array<ReturnType<typeof deferred<DesignSelection>>> = [];
  const edits: Array<ReturnType<typeof deferred<DesignEditResult>>> = [];
  const api = {
    designSelection: vi.fn((_app: string, _s: NodeSelection) => { const d = deferred<DesignSelection>(); loads.push(d); return d.promise; }),
    editDesign: vi.fn((_app: string, _rev: string, _ops: unknown[], _s?: NodeSelection) => { const d = deferred<DesignEditResult>(); edits.push(d); return d.promise; }),
  };
  const onResult = vi.fn();
  const model = createInspectorModel({ app: 'a', api, onResult });
  return { model, api, loads, edits, onResult };
}

describe('inspector model', () => {
  it('loads a selection, picks the first target and the selection’s device', async () => {
    const t = setup();
    const done = t.model.select(sel('n1', 'tablet'));
    expect(t.model.state().loading).toBe(true);
    t.loads[0]!.resolve(info('n1', 'r1', 'tablet'));
    await done;
    expect(t.model.state()).toMatchObject({ loading: false, targetId: 'n1', device: 'tablet', error: null });
  });

  it('drops a load that finishes after a newer selection (the old target never fills the new fields)', async () => {
    const t = setup();
    const first = t.model.select(sel('n1'));
    const second = t.model.select(sel('n2'));
    t.loads[1]!.resolve(info('n2'));
    await second;
    t.loads[0]!.resolve(info('n1'));
    await first;
    expect(t.model.state().info?.selection.nodeIds).toEqual(['n2']);
    expect(t.model.state().targetId).toBe('n2');
  });

  it('keeps the chosen target and device when the same selection reloads after an edit', async () => {
    const t = setup();
    const a = t.model.select(sel('n1')); t.loads[0]!.resolve(info('n1')); await a;
    t.model.setTarget('n1-c');
    t.model.setDevice('mobile');
    const b = t.model.select(sel('n1')); t.loads[1]!.resolve(info('n1', 'r2')); await b;
    expect(t.model.state()).toMatchObject({ targetId: 'n1-c', device: 'mobile' });
  });

  it('marks an edit busy, sends it with the loaded revision and selection, and reports the result', async () => {
    const t = setup();
    const a = t.model.select(sel('n1')); t.loads[0]!.resolve(info('n1', 'r7')); await a;
    const ops = [{ op: 'setStyle', node: 'n1', device: 'base', prop: 'color', value: 'red' }];
    const edit = t.model.edit('typography:color', ops);
    expect(t.model.state().pending.has('typography:color')).toBe(true);
    expect(t.api.editDesign).toHaveBeenCalledWith('a', 'r7', ops, sel('n1'));
    const result: DesignEditResult = { mode: 'applied', revision: 'r8', warnings: [] };
    t.edits[0]!.resolve(result);
    await edit;
    expect(t.model.state().pending.size).toBe(0);
    expect(t.onResult).toHaveBeenCalledWith(result);
  });

  it('on a failed edit reverts the fields and shows the error under its section', async () => {
    const t = setup();
    const a = t.model.select(sel('n1')); t.loads[0]!.resolve(info('n1')); await a;
    const epoch = t.model.state().epoch;
    const edit = t.model.edit('spacing:gap', []);
    t.edits[0]!.reject(new ApiError(400, 'Invalid value "x" for gap'));
    await edit;
    expect(t.model.state().errors).toEqual({ spacing: 'Invalid value "x" for gap' });
    expect(t.model.state().epoch).toBe(epoch + 1);
    expect(t.onResult).not.toHaveBeenCalled();
  });

  it('on a stale revision (409) also reloads the selection', async () => {
    const t = setup();
    const a = t.model.select(sel('n1')); t.loads[0]!.resolve(info('n1', 'r1')); await a;
    const edit = t.model.edit('typography:color', []);
    t.edits[0]!.reject(new ApiError(409, 'The design changed; try again.'));
    await edit;
    expect(t.api.designSelection).toHaveBeenCalledTimes(2);
    expect(t.model.state().errors).toEqual({ typography: 'The design changed; try again.' });
    t.loads[1]!.resolve(info('n1', 'r2'));
    await Promise.resolve(); await Promise.resolve();
    expect(t.model.state().info?.revision).toBe('r2');
  });

  it('clears a section’s error on its next edit', async () => {
    const t = setup();
    const a = t.model.select(sel('n1')); t.loads[0]!.resolve(info('n1')); await a;
    const e1 = t.model.edit('fill:background-color', []); t.edits[0]!.reject(new Error('nope')); await e1;
    void t.model.edit('fill:background-color', []);
    expect(t.model.state().errors).toEqual({});
  });

  it('shows a load error and clears everything for no selection', async () => {
    const t = setup();
    const a = t.model.select(sel('n1')); t.loads[0]!.reject(new Error('Selection could not be read.')); await a;
    expect(t.model.state().error).toBe('Selection could not be read.');
    await t.model.select(null);
    expect(t.model.state()).toMatchObject({ info: null, error: null, loading: false });
  });
});
