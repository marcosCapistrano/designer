// The inspector's state and server calls, kept out of the component so they can be tested without a DOM.
import type { DesignEditResult, DesignSelection, Device, EditScope, NodeSelection } from '@hub/protocol';
import { ApiError } from '../../../net/api.js';
import type { ApiClient } from '../../../net/api.js';

export interface InspectorState {
  info: DesignSelection | null;
  loading: boolean;
  /** Why the selection could not be read. */
  error: string | null;
  targetId: string;
  device: Device;
  /** Edits in flight, as `targetId␀section:prop`; read them for one target with pendingFor. */
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

const SEP = '\u0000';

/**
 * Page mode edits what is on the page (a tapped component is its instance); component mode edits the component's
 * definition, so only shared targets apply, and its edits carry the scope that lets them apply at once.
 */
export interface SelectOptions { mode: 'page' | 'component'; scope?: EditScope }

/** The targets a mode edits; every target when the mode would leave none. */
function forMode(info: DesignSelection, options?: SelectOptions): DesignSelection {
  if (!options) return info;
  const kept = info.targets.filter((t) => t.shared === (options.mode === 'component'));
  return kept.length ? { ...info, targets: kept } : info;
}

/** The control keys (`section:prop`) with an edit in flight for one target. */
export function pendingFor(state: InspectorState, targetId: string): ReadonlySet<string> {
  const prefix = targetId + SEP;
  return new Set([...state.pending].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
}

const message = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback);
const sameNodes = (a: NodeSelection | null | undefined, b: NodeSelection | null): boolean =>
  !!a && !!b && a.pageId === b.pageId && a.nodeIds.length === b.nodeIds.length && a.nodeIds.every((id, i) => id === b.nodeIds[i]);

export function createInspectorModel({ app, api, onResult }: InspectorModelDeps) {
  let state: InspectorState = { info: null, loading: false, error: null, targetId: '', device: 'base', pending: new Set(), errors: {}, epoch: 0 };
  let token = 0;
  let current: NodeSelection | null = null;
  let scope: EditScope | undefined;
  let lastOptions: SelectOptions | undefined;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<InspectorState>): void => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };

  async function select(selection: NodeSelection | null, options?: SelectOptions): Promise<void> {
    const mine = ++token;
    lastOptions = options;
    scope = options?.mode === 'component' ? options.scope : undefined;
    const same = sameNodes(current, selection);
    current = selection;
    if (!selection) { set({ info: null, loading: false, error: null, targetId: '', errors: {} }); return; }
    set({ loading: true, error: null, ...(same ? {} : { info: null, errors: {} }) });
    try {
      const info = forMode(await api.designSelection(app, selection), options);
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
    const pendingKey = state.targetId + SEP + key;
    // The selection this edit belongs to: if the user has moved on when it fails, the failure is not shown on
    // the new selection (a reload of the same nodes at a new revision still counts as the same selection).
    const at = current;
    const { [section]: _cleared, ...errors } = state.errors;
    set({ pending: new Set([...state.pending, pendingKey]), errors });
    const done = (): ReadonlySet<string> => new Set([...state.pending].filter((k) => k !== pendingKey));
    try {
      const result = await api.editDesign(app, info.revision, ops, info.selection, scope);
      set({ pending: done() });
      onResult(result);
    } catch (error) {
      if (!sameNodes(at, current)) { set({ pending: done() }); return; }
      set({ pending: done(), errors: { ...state.errors, [section]: message(error, 'Edit failed.') }, epoch: state.epoch + 1 });
      // Another edit (say, from chat) moved the design on: read the selection again at the new revision.
      if (error instanceof ApiError && error.status === 409) void select(current, lastOptions);
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
