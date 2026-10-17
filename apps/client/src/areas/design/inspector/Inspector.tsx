// The inspector: what was tapped, the device tier edits go to, and the sections of controls.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { DesignEditResult, DesignTarget, Device, EditScope, NodeSelection } from '@hub/protocol';
import type { ApiClient } from '../../../net/api.js';
import { IconButton } from '../../../ui/IconButton.js';
import { Segmented } from '../../../ui/Segmented.js';
import { CloseIcon, UpIcon } from '../../../ui/icons.js';
import { BorderSection, ComponentSection, FillSection, RawSection, SizeSection, SpacingSection, TextSection, TypographySection, VisibilitySection } from './sections.js';
import { FIELDS, shownFields, textBearing } from './fields.js';
import type { FieldSection } from './fields.js';
import { commitHandlers } from '../../../ui/commit.js';
import type { SectionProps } from './sections.js';
import type { SideKind } from './values.js';
import { createInspectorModel, pendingFor } from './model.js';
import type { InspectorState } from './model.js';
import './inspector.css';

const DEVICES: readonly { value: Device; label: string }[] = [
  { value: 'base', label: 'Desktop' },
  { value: 'tablet', label: 'Tablet' },
  { value: 'mobile', label: 'Mobile' },
];

const styled = (t: DesignTarget): boolean => t.kind !== 'text';

export interface SectionDef {
  id: string;
  title: string;
  show(t: DesignTarget): boolean;
  view(p: SectionProps): JSX.Element | null;
  closed?: boolean;
}

export const SECTIONS: readonly SectionDef[] = [
  { id: 'text', title: 'Text', show: (t) => !!t.textNode, view: TextSection },
  { id: 'typography', title: 'Typography', show: (t) => styled(t) && textBearing(t), view: TypographySection },
  { id: 'fill', title: 'Fill', show: styled, view: FillSection },
  { id: 'spacing', title: 'Spacing', show: styled, view: SpacingSection },
  { id: 'size', title: 'Size', show: styled, view: SizeSection },
  { id: 'border', title: 'Border', show: styled, view: BorderSection },
  { id: 'visibility', title: 'Visibility', show: styled, view: VisibilitySection },
  { id: 'component', title: 'Component', show: (t) => t.kind === 'instance', view: ComponentSection },
  { id: 'raw', title: 'All CSS', show: styled, view: RawSection, closed: true },
];

const isFieldSection = (id: string): id is FieldSection => Object.hasOwn(FIELDS, id);

/** What the header calls the target's kind: its component, Text, or Frame. */
function kindLabel(t: DesignTarget): string {
  if (t.kind === 'instance') return t.title ?? t.component ?? 'Component';
  return t.kind === 'text' || textBearing(t) ? 'Text' : 'Frame';
}

const SECTIONS_KEY = 'hub.inspector.sections';
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

export function readSections(storage: Storage): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(SECTIONS_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}
export const writeSections = (storage: Storage, sections: Record<string, boolean>): void => storage.setItem(SECTIONS_KEY, JSON.stringify(sections));

export interface InspectorViewProps {
  state: InspectorState;
  sections: Record<string, boolean>;
  linked: Record<SideKind, boolean>;
  locked: boolean;
  onTarget(id: string): void;
  onDevice(device: Device): void;
  onToggleSection(id: string, open: boolean): void;
  onLink(kind: SideKind, linked: boolean): void;
  onEdit(key: string, ops: unknown[]): void;
  onClose(): void;
  onRetry(): void;
  /** Fields added from + menus, as `section:prop`. */
  added: ReadonlySet<string>;
  onAdd(key: string): void;
  /** Page mode edits the page; component mode edits a component in place (its edits apply at once). */
  mode: 'page' | 'component';
  /** In component mode, where the target sits: "Filter Panel › Verticais". */
  path: string | null;
  onEnterComponent(targetId: string): void;
  /** Selects the layer one level up; absent at the top. */
  onParent?(): void;
}

export function InspectorView(p: InspectorViewProps): JSX.Element {
  const { state } = p;
  const targets = state.info?.targets ?? [];
  const target = targets.find((t) => t.id === state.targetId);
  const name = target ? (target.name ?? target.tag ?? target.component ?? target.kind) : '';
  const rename = target && target.kind !== 'text'
    ? commitHandlers(name, (value) => p.onEdit('name:name', [{ op: 'setName', node: target.id, name: value }]))
    : null;
  const sectionProps = (t: DesignTarget): SectionProps => ({
    target: t, device: state.device, epoch: state.epoch, pending: pendingFor(state, t.id), locked: p.locked, linked: p.linked, added: p.added,
    onLink: p.onLink, onEdit: p.onEdit, onEnterComponent: p.onEnterComponent,
  });
  return (
    <div class="inspector" data-testid="inspector">
      <header class="inspector-head">
        <div class="inspector-title">
          {target && (rename
            ? <input key={`${target.id}:${name}:${state.epoch}`} class="inspector-name" aria-label="Layer name" data-testid="inspector-name" defaultValue={name} disabled={p.locked} {...rename} />
            : <span class="inspector-name" data-testid="inspector-name">{name}</span>)}
          {target && <span class="inspector-kind" data-testid="inspector-kind">{kindLabel(target)}</span>}
          {p.path && <span class="inspector-path" data-testid="inspector-path">{p.path}</span>}
        </div>
        {p.onParent && <IconButton label="Select parent" icon={<UpIcon />} onClick={p.onParent} data-testid="inspector-parent" />}
        <IconButton label="Close inspector" icon={<CloseIcon />} onClick={p.onClose} data-testid="inspector-close" />
      </header>
      {state.errors['name'] && <p class="inspector-section-error" role="alert" data-testid="section-name-error">{state.errors['name']}</p>}
      {targets.length > 1 && (
        <div class="inspector-chips" role="group" aria-label="Edit target">
          {targets.map((t) => (
            <button key={t.id} type="button" class={t.id === state.targetId ? 'inspector-chip inspector-chip-on' : 'inspector-chip'} aria-pressed={t.id === state.targetId ? 'true' : 'false'}
              data-testid={`inspector-target-${t.id}`} onClick={() => p.onTarget(t.id)}>
              <span>{t.name ?? t.tag ?? t.component ?? t.kind}</span>
              {t.shared && <span class="inspector-badge">Shared</span>}
            </button>
          ))}
        </div>
      )}
      {target?.shared && p.mode === 'page' && <p class="inspector-note" data-testid="inspector-shared-note">Shared component. Edits preview before they apply.</p>}
      <div class="inspector-device">
        <Segmented value={state.device} options={DEVICES} label="Edit styles for" disabled={p.locked} onChange={p.onDevice} data-testid="inspector-device" />
      </div>
      {state.loading && !state.info && <p class="inspector-note" data-testid="inspector-loading">Loading…</p>}
      {state.error && (
        <div class="inspector-error" role="alert" data-testid="inspector-error">
          <span>{state.error}</span>
          <button type="button" class="ui-button" data-testid="inspector-retry" onClick={p.onRetry}>Retry</button>
        </div>
      )}
      {target && SECTIONS.filter((s) => s.show(target)).map((s) => {
        const fields = isFieldSection(s.id) ? shownFields(s.id, target, state.device, p.added) : null;
        const hidden = fields ? FIELDS[s.id as FieldSection].filter((f) => !fields.includes(f.prop)) : [];
        const empty = fields !== null && fields.length === 0;
        const open = !empty && (p.sections[s.id] ?? !s.closed);
        const View = s.view;
        return (
          <section key={s.id} class={empty ? 'inspector-section inspector-section-empty' : 'inspector-section'}>
            <div class="inspector-section-row">
              <button type="button" class="inspector-section-head" aria-expanded={open ? 'true' : 'false'} disabled={empty} data-testid={`section-${s.id}`} onClick={() => p.onToggleSection(s.id, !open)}>
                <span>{s.title}</span>{!empty && <span class="inspector-chevron" aria-hidden="true">{open ? '−' : '+'}</span>}
              </button>
              {hidden.length > 0 && (
                <select class="inspector-add" aria-label={`Add to ${s.title}`} title={`Add to ${s.title}`} value="" disabled={p.locked} data-testid={`section-${s.id}-add`}
                  onChange={(e) => { const prop = (e.currentTarget as HTMLSelectElement).value; if (prop) p.onAdd(`${s.id}:${prop}`); }}>
                  <option value="" disabled hidden>＋</option>
                  {hidden.map((f) => <option key={f.prop} value={f.prop} data-testid={`add-${s.id}-${f.prop}`}>{f.label}</option>)}
                </select>
              )}
            </div>
            {open && (
              <div class="inspector-section-body" data-testid={`section-${s.id}-body`}>
                <View {...sectionProps(target)} />
              </div>
            )}
            {state.errors[s.id] && <p class="inspector-section-error" role="alert" data-testid={`section-${s.id}-error`}>{state.errors[s.id]}</p>}
          </section>
        );
      })}
    </div>
  );
}

export interface InspectorProps {
  app: string;
  api: Pick<ApiClient, 'designSelection' | 'editDesign'>;
  selection: NodeSelection;
  /** The design's revision; a new one reloads the selection's values. */
  revision: string | null;
  disabled: boolean;
  onResult(result: DesignEditResult): void;
  onClose(): void;
  /** The active target's name ("h3", "AdListCard"), or null while none is loaded. */
  onLabel?(label: string | null): void;
  /** Whether any of its edits is in flight. */
  onPending?(busy: boolean): void;
  /** Page mode (default) or editing a component in place, whose edits carry `scope`. */
  mode?: 'page' | 'component';
  scope?: EditScope;
  path?: string | null;
  onEnterComponent?(targetId: string): void;
  onParent?(): void;
}

export function Inspector({ app, api, selection, revision, disabled, onResult, onClose, onLabel, onPending, mode = 'page', scope, path = null, onEnterComponent, onParent }: InspectorProps): JSX.Element {
  const [, rerender] = useState(0);
  const resultRef = useRef(onResult);
  resultRef.current = onResult;
  const model = useMemo(() => createInspectorModel({ app, api, onResult: (r) => resultRef.current(r) }), [app, api]);
  const [sections, setSections] = useState<Record<string, boolean>>(() => readSections(localStorage));
  const [linked, setLinked] = useState<Record<SideKind, boolean>>({ padding: false, margin: false });
  useEffect(() => model.subscribe(() => rerender((n) => n + 1)), [model]);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => { void model.select(selection, { mode, ...(scope ? { scope } : {}) }); }, [model, selection, revision, mode, scope?.component]);
  // Fields added from + menus belong to the selection they were added on.
  useEffect(() => setAdded(new Set()), [selection]);
  const state = model.state();
  const active = state.info?.targets.find((t) => t.id === state.targetId);
  const label = active ? (active.name ?? active.tag ?? active.component ?? active.kind) : null;
  useEffect(() => { onLabel?.(label); }, [label, onLabel]);
  const busy = state.pending.size > 0;
  useEffect(() => { onPending?.(busy); }, [busy, onPending]);
  // Unmounting mid-edit must not leave the area thinking an edit is still in flight.
  useEffect(() => () => onPending?.(false), [onPending]);
  return (
    <InspectorView
      state={state}
      sections={sections}
      linked={linked}
      locked={disabled}
      onTarget={model.setTarget}
      onDevice={model.setDevice}
      onToggleSection={(id, open) => { const next = { ...sections, [id]: open }; setSections(next); writeSections(localStorage, next); }}
      onLink={(kind, on) => setLinked({ ...linked, [kind]: on })}
      onEdit={(key, ops) => void model.edit(key, ops)}
      onClose={onClose}
      onRetry={() => void model.select(selection, { mode, ...(scope ? { scope } : {}) })}
      added={added}
      onAdd={(key) => setAdded(new Set([...added, key]))}
      mode={mode}
      path={path}
      onEnterComponent={(id) => onEnterComponent?.(id)}
      {...(onParent ? { onParent } : {})}
    />
  );
}
