// The inspector's state and server calls, kept out of the component so they can be tested without a DOM.
import type { DesignEditResult, DesignSelection, Device, NodeSelection } from '@hub/protocol';
import { ApiError } from '../../../net/api.js';
import type { ApiClient } from '../../../net/api.js';

export interface InspectorState {
  info: DesignSelection | null;
  loading: boolean;
  /** Why the selection could not be read. */
  error: string | null;
  targetId: string;
  device: Device;
  /** Control keys (`section:prop`) with an edit in flight. */
  pending: ReadonlySet<string>;
  /** The last failed edit's message, by section. */
  errors: Readonly<Record<string, string>>;
  /** Bumped when an edit fails, so fields remount and drop what was typed. */
  epoch: number;
}

export interface InspectorModelDeps {
  app: string;
  api: Pick<ApiClient, 'designSelection' | 'editDesign'>;
  onResult(result: DesignEditResult): void;
}

const message = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback);
const sameNodes = (a: NodeSelection | null | undefined, b: NodeSelection | null): boolean =>
  !!a && !!b && a.pageId === b.pageId && a.nodeIds.length === b.nodeIds.length && a.nodeIds.every((id, i) => id === b.nodeIds[i]);

export function createInspectorModel({ app, api, onResult }: InspectorModelDeps) {
  let state: InspectorState = { info: null, loading: false, error: null, targetId: '', device: 'base', pending: new Set(), errors: {}, epoch: 0 };
  let token = 0;
  let current: NodeSelection | null = null;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<InspectorState>): void => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };

  async function select(selection: NodeSelection | null): Promise<void> {
    const mine = ++token;
    const same = sameNodes(current, selection);
    current = selection;
    if (!selection) { set({ info: null, loading: false, error: null, targetId: '', errors: {} }); return; }
    set({ loading: true, error: null, ...(same ? {} : { info: null, errors: {} }) });
    try {
      const info = await api.designSelection(app, selection);
      if (mine !== token) return;
      const keepTarget = same && info.targets.some((t) => t.id === state.targetId);
      set({
        info,
        loading: false,
        targetId: keepTarget ? state.targetId : (info.targets[0]?.id ?? ''),
        device: same ? state.device : selection.device,
      });
    } catch (error) {
      if (mine !== token) return;
      set({ loading: false, error: message(error, 'Selection could not be read.') });
    }
  }

  async function edit(key: string, ops: unknown[]): Promise<void> {
    const info = state.info;
    if (!info) return;
    const section = key.split(':')[0]!;
    const { [section]: _cleared, ...errors } = state.errors;
    set({ pending: new Set([...state.pending, key]), errors });
    const done = (): ReadonlySet<string> => new Set([...state.pending].filter((k) => k !== key));
    try {
      const result = await api.editDesign(app, info.revision, ops, info.selection);
      set({ pending: done() });
      onResult(result);
    } catch (error) {
      set({ pending: done(), errors: { ...state.errors, [section]: message(error, 'Edit failed.') }, epoch: state.epoch + 1 });
      // Another edit (say, from chat) moved the design on: read the selection again at the new revision.
      if (error instanceof ApiError && error.status === 409) void select(current);
    }
  }

  return {
    state: (): InspectorState => state,
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); },
    select,
    edit,
    setTarget: (targetId: string): void => set({ targetId }),
    setDevice: (device: Device): void => set({ device }),
  };
}

export type InspectorModel = ReturnType<typeof createInspectorModel>;
