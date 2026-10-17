import type { JSX } from 'preact';
import { isLiteralColor, isPickerHex } from './color.js';
import { commitHandlers } from './commit.js';

export interface ColorFieldProps {
  value: string;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  busy?: boolean;
  /** The value is inherited from another tier: shown dimmed, still editable. */
  muted?: boolean;
  onCommit(value: string | null): void;
  'data-testid'?: string;
}

/** A swatch and a text field. The swatch previews literal colors only; six-digit hex also opens the native picker. */
export function ColorField({ value, label, placeholder, disabled, busy, muted, onCommit, 'data-testid': id = 'color' }: ColorFieldProps): JSX.Element {
  const literal = isLiteralColor(value);
  const off = Boolean(disabled || busy);
  return (
    // A div, not a label: a label would forward a tap on its caption to its first control (the − button or the picker).
    <div class="ui-field" role="group" aria-label={label} data-testid={id}>
      <span class="ui-field-label">{label}{busy && <span class="ui-spinner" aria-hidden="true" />}</span>
      <span class="ui-color">
        <span class={literal ? 'ui-swatch' : 'ui-swatch ui-swatch-neutral'} data-testid={`${id}-swatch`} style={literal ? `background:${value}` : undefined}>
          {isPickerHex(value) && (
            <input type="color" class="ui-swatch-picker" data-testid={`${id}-picker`} value={value} disabled={off} aria-label={`Pick ${label}`}
              onChange={(event) => onCommit((event as unknown as { currentTarget: { value: string } }).currentTarget.value)} />
          )}
        </span>
        <input key={value} class={muted ? 'ui-input ui-mono ui-input-muted' : 'ui-input ui-mono'} data-testid={`${id}-input`} defaultValue={value} placeholder={placeholder} disabled={off} aria-label={label} {...commitHandlers(value, onCommit)} />
      </span>
    </div>
  );
}
