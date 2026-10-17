// The inspector's sections. Each is a pure view: it shows the target's values on the chosen device tier and
// reports a committed change as one edit (`onEdit(key, ops)`), where `key` names the control for its busy state.
import type { JSX } from 'preact';
import type { DesignTarget, Device } from '@hub/protocol';
import { ColorField } from '../../../ui/ColorField.js';
import { Stepper } from '../../../ui/Stepper.js';
import { Toggle } from '../../../ui/Toggle.js';
import { commitHandlers } from '../../../ui/commit.js';
import { effectiveStyle, inheritedLabel, sideProps, sideValues } from './values.js';
import type { SideKind } from './values.js';

export interface SectionProps {
  target: DesignTarget;
  device: Device;
  /** Bumped when an edit fails, so the fields remount and drop what was typed. */
  epoch: number;
  pending: ReadonlySet<string>;
  locked: boolean;
  linked: Record<SideKind, boolean>;
  onLink(kind: SideKind, linked: boolean): void;
  onEdit(key: string, ops: unknown[]): void;
}

const setStyle = (p: SectionProps, prop: string, value: string | null) => ({ op: 'setStyle', node: p.target.id, device: p.device, prop, value });

/** A stepper or color field bound to one property on the chosen tier. */
function field(p: SectionProps, section: string, prop: string, label: string, kind: 'length' | 'color'): JSX.Element {
  const shown = effectiveStyle(p.target.style, p.device, prop);
  const key = `${section}:${prop}`;
  const common = {
    key: `${prop}:${p.epoch}`,
    label,
    // An inherited value is shown dimmed; committing a change writes this tier's own value.
    value: shown.value,
    muted: shown.inherited !== null,
    placeholder: shown.inherited ? inheritedLabel(shown.inherited) : undefined,
    disabled: p.locked,
    busy: p.pending.has(key),
    onCommit: (value: string | null) => p.onEdit(key, [setStyle(p, prop, value)]),
    'data-testid': `${section}-${prop}`,
  };
  return kind === 'color' ? <ColorField {...common} /> : <Stepper {...common} />;
}

export function TextSection(p: SectionProps): JSX.Element | null {
  const { textNode, text = '' } = p.target;
  if (!textNode) return null;
  const { onBlur } = commitHandlers(text, (value) => p.onEdit('text:text', [{ op: 'setText', node: textNode, text: value ?? '' }]));
  return (
    <label class="ui-field">
      <span class="ui-field-label">Text{p.pending.has('text:text') && <span class="ui-spinner" aria-hidden="true" />}</span>
      <textarea key={`text:${p.epoch}:${text}`} class="ui-textarea" data-testid="text-text" defaultValue={text} disabled={p.locked || p.pending.has('text:text')} onBlur={onBlur} />
    </label>
  );
}

const WEIGHTS = ['400', '500', '600', '700'];

export function TypographySection(p: SectionProps): JSX.Element {
  const weight = effectiveStyle(p.target.style, p.device, 'font-weight');
  const options = weight.value && !WEIGHTS.includes(weight.value) ? [weight.value, ...WEIGHTS] : WEIGHTS;
  return (
    <div class="inspector-grid">
      {field(p, 'typography', 'font-size', 'Size', 'length')}
      <label class="ui-field">
        <span class="ui-field-label">Weight{p.pending.has('typography:font-weight') && <span class="ui-spinner" aria-hidden="true" />}</span>
        <select class="ui-select" data-testid="typography-font-weight" value={weight.value} disabled={p.locked || p.pending.has('typography:font-weight')}
          onChange={(event) => { const v = (event as unknown as { currentTarget: { value: string } }).currentTarget.value; p.onEdit('typography:font-weight', [setStyle(p, 'font-weight', v || null)]); }}>
          <option value="">{weight.inherited ? inheritedLabel(weight.inherited) : 'Default'}</option>
          {options.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
      </label>
      {field(p, 'typography', 'line-height', 'Line height', 'length')}
      {field(p, 'typography', 'color', 'Color', 'color')}
    </div>
  );
}

export const FillSection = (p: SectionProps): JSX.Element => <div class="inspector-grid">{field(p, 'fill', 'background-color', 'Background', 'color')}</div>;

const SIDE_LABELS = ['Top', 'Right', 'Bottom', 'Left'];

function sides(p: SectionProps, kind: SideKind): JSX.Element {
  const shown = sideValues(p.target.style, p.device, kind);
  const props = sideProps(kind);
  const linked = p.linked[kind];
  return (
    <div class="inspector-sides">
      <div class="inspector-sides-head">
        <span class="ui-field-label">{kind === 'padding' ? 'Padding' : 'Margin'}</span>
        <Toggle checked={linked} label="All sides" disabled={p.locked} onChange={(on) => p.onLink(kind, on)} data-testid={`spacing-${kind}-link`} />
      </div>
      <div class="inspector-grid">
        {props.map((prop, i) => {
          const s = shown[i]!;
          const key = `spacing:${prop}`;
          return (
            <Stepper
              key={`${prop}:${p.epoch}`}
              label={SIDE_LABELS[i]!}
              value={s.value}
              muted={s.inherited !== null}
              placeholder={s.inherited ? inheritedLabel(s.inherited) : undefined}
              disabled={p.locked}
              busy={p.pending.has(key)}
              onCommit={(value) => p.onEdit(key, linked ? props.map((side) => setStyle(p, side, value)) : [setStyle(p, prop, value)])}
              data-testid={`spacing-${prop}`}
            />
          );
        })}
      </div>
    </div>
  );
}

export function SpacingSection(p: SectionProps): JSX.Element {
  return (
    <div class="inspector-stack">
      {sides(p, 'padding')}
      {sides(p, 'margin')}
      <div class="inspector-grid">{field(p, 'spacing', 'gap', 'Gap', 'length')}</div>
    </div>
  );
}

export const SizeSection = (p: SectionProps): JSX.Element => (
  <div class="inspector-grid">
    {field(p, 'size', 'width', 'Width', 'length')}
    {field(p, 'size', 'height', 'Height', 'length')}
    {field(p, 'size', 'max-width', 'Max width', 'length')}
  </div>
);

export const BorderSection = (p: SectionProps): JSX.Element => (
  <div class="inspector-grid">
    {field(p, 'border', 'border-width', 'Width', 'length')}
    {field(p, 'border', 'border-color', 'Color', 'color')}
    {field(p, 'border', 'border-radius', 'Radius', 'length')}
  </div>
);

export function VisibilitySection(p: SectionProps): JSX.Element {
  const shown = effectiveStyle(p.target.style, p.device, 'display');
  const hidden = shown.value === 'none';
  // Showing again: drop this tier's own `none`, or override a `none` this tier inherits.
  const show = shown.inherited === null ? null : 'revert';
  return (
    <Toggle checked={!hidden} label="Visible on this device" disabled={p.locked || p.pending.has('visibility:display')}
      onChange={(visible) => p.onEdit('visibility:display', [setStyle(p, 'display', visible ? show : 'none')])} data-testid="visibility-visible" />
  );
}

export function PropsSection(p: SectionProps): JSX.Element | null {
  const declared = p.target.declaredProps;
  if (!declared) return null;
  return (
    <div class="inspector-stack">
      {Object.entries(declared).map(([name, current]) => {
        const key = `props:${name}`;
        return (
          <label key={`${name}:${p.epoch}`} class="ui-field">
            <span class="ui-field-label">{name}{p.pending.has(key) && <span class="ui-spinner" aria-hidden="true" />}</span>
            <input key={current} class="ui-input" data-testid={`props-${name}-input`} defaultValue={current} disabled={p.locked || p.pending.has(key)}
              {...commitHandlers(current, (value) => p.onEdit(key, [{ op: 'setInstanceProp', node: p.target.id, prop: name, value: value ?? '' }]))} />
          </label>
        );
      })}
    </div>
  );
}

export function RawSection(p: SectionProps): JSX.Element {
  return (
    <form class="inspector-raw" onSubmit={(event) => {
      event.preventDefault();
      const elements = (event.currentTarget as HTMLFormElement).elements;
      const prop = (elements.namedItem('prop') as HTMLInputElement).value.trim();
      const value = (elements.namedItem('value') as HTMLInputElement).value.trim();
      if (prop) p.onEdit(`raw:${prop}`, [setStyle(p, prop, value || null)]);
    }}>
      <label class="ui-field"><span class="ui-field-label">Property</span><input name="prop" class="ui-input ui-mono" placeholder="letter-spacing" disabled={p.locked} data-testid="raw-prop" /></label>
      <label class="ui-field"><span class="ui-field-label">Value</span><input name="value" class="ui-input ui-mono" placeholder="Blank removes it" disabled={p.locked} data-testid="raw-value" /></label>
      <button type="submit" class="ui-button ui-button-primary" disabled={p.locked} data-testid="raw-apply">Apply</button>
    </form>
  );
}
