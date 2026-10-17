// The inspector: what was tapped, the device tier edits go to, and the sections of controls.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { DesignEditResult, DesignTarget, Device, NodeSelection } from '@hub/protocol';
import type { ApiClient } from '../../../net/api.js';
import { IconButton } from '../../../ui/IconButton.js';
import { Segmented } from '../../../ui/Segmented.js';
import { CloseIcon } from '../../../ui/icons.js';
import { BorderSection, FillSection, PropsSection, RawSection, SizeSection, SpacingSection, TextSection, TypographySection, VisibilitySection } from './sections.js';
import type { SectionProps } from './sections.js';
import type { SideKind } from './values.js';
import { createInspectorModel } from './model.js';
import type { InspectorState } from './model.js';
import './inspector.css';

const DEVICES: readonly { value: Device; label: string }[] = [
  { value: 'base', label: 'Desktop' },
  { value: 'tablet', label: 'Tablet' },
  { value: 'mobile', label: 'Mobile' },
];

const styled = (t: DesignTarget): boolean => t.kind !== 'text';

export const SECTIONS: readonly { id: string; title: string; show(t: DesignTarget): boolean; view(p: SectionProps): JSX.Element | null; closed?: boolean }[] = [
  { id: 'text', title: 'Text', show: (t) => !!t.textNode, view: TextSection },
  { id: 'typography', title: 'Typography', show: styled, view: TypographySection },
  { id: 'fill', title: 'Fill', show: styled, view: FillSection },
  { id: 'spacing', title: 'Spacing', show: styled, view: SpacingSection },
  { id: 'size', title: 'Size', show: styled, view: SizeSection },
  { id: 'border', title: 'Border', show: styled, view: BorderSection },
  { id: 'visibility', title: 'Visibility', show: styled, view: VisibilitySection },
  { id: 'props', title: 'Props', show: (t) => t.kind === 'instance' && !!t.declaredProps, view: PropsSection },
  { id: 'raw', title: 'Any CSS property', show: styled, view: RawSection, closed: true },
];

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
}

export function InspectorView(p: InspectorViewProps): JSX.Element {
  const { state } = p;
  const target = state.info?.targets.find((t) => t.id === state.targetId);
  return (
    <div class="inspector" data-testid="inspector">
      <header class="inspector-head">
        <div class="inspector-chips" role="group" aria-label="Edit target">
          {state.info?.targets.map((t) => (
            <button key={t.id} type="button" class={t.id === state.targetId ? 'inspector-chip inspector-chip-on' : 'inspector-chip'} aria-pressed={t.id === state.targetId ? 'true' : 'false'}
              data-testid={`inspector-target-${t.id}`} onClick={() => p.onTarget(t.id)}>
              <span class="ui-mono">{t.tag ?? t.component ?? t.kind}</span>
              {t.shared && <span class="inspector-badge">Shared</span>}
            </button>
          ))}
        </div>
        <IconButton label="Close inspector" icon={<CloseIcon />} onClick={p.onClose} data-testid="inspector-close" />
      </header>
      {target?.shared && <p class="inspector-note" data-testid="inspector-shared-note">Shared component. Edits preview before they apply.</p>}
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
        const open = p.sections[s.id] ?? !s.closed;
        const View = s.view;
        return (
          <section key={s.id} class="inspector-section">
            <button type="button" class="inspector-section-head" aria-expanded={open ? 'true' : 'false'} data-testid={`section-${s.id}`} onClick={() => p.onToggleSection(s.id, !open)}>
              <span>{s.title}</span><span class="inspector-chevron" aria-hidden="true">{open ? '−' : '+'}</span>
            </button>
            {open && (
              <div class="inspector-section-body">
                <View target={target} device={state.device} epoch={state.epoch} pending={state.pending} locked={p.locked} linked={p.linked} onLink={p.onLink} onEdit={p.onEdit} />
                {state.errors[s.id] && <p class="inspector-section-error" role="alert" data-testid={`section-${s.id}-error`}>{state.errors[s.id]}</p>}
              </div>
            )}
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
}

export function Inspector({ app, api, selection, revision, disabled, onResult, onClose, onLabel }: InspectorProps): JSX.Element {
  const [, rerender] = useState(0);
  const resultRef = useRef(onResult);
  resultRef.current = onResult;
  const model = useMemo(() => createInspectorModel({ app, api, onResult: (r) => resultRef.current(r) }), [app, api]);
  const [sections, setSections] = useState<Record<string, boolean>>(() => readSections(localStorage));
  const [linked, setLinked] = useState<Record<SideKind, boolean>>({ padding: false, margin: false });
  useEffect(() => model.subscribe(() => rerender((n) => n + 1)), [model]);
  useEffect(() => { void model.select(selection); }, [model, selection, revision]);
  const state = model.state();
  const active = state.info?.targets.find((t) => t.id === state.targetId);
  const label = active ? (active.tag ?? active.component ?? active.kind) : null;
  useEffect(() => { onLabel?.(label); }, [label, onLabel]);
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
      onRetry={() => void model.select(selection)}
    />
  );
}
