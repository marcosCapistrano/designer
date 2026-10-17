import type { JSX } from 'preact';
import { commitHandlers } from './commit.js';
import { parseLength, stepValue } from './length.js';

export interface StepperProps {
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

/**
 * A length field with − and + buttons. The input is uncontrolled and keyed by the value, so a new value from the
 * server resets it while the user's own typing is left alone until it commits.
 */
export function Stepper({ value, label, placeholder, disabled, busy, muted, onCommit, 'data-testid': id = 'stepper' }: StepperProps): JSX.Element {
  const steppable = parseLength(value) !== null;
  const off = Boolean(disabled || busy);
  return (
    <label class="ui-field" data-testid={id}>
      <span class="ui-field-label">{label}{busy && <span class="ui-spinner" aria-hidden="true" />}</span>
      <span class="ui-stepper">
        <button type="button" class="ui-stepper-btn" aria-label={`Decrease ${label}`} data-testid={`${id}-minus`} disabled={off || !steppable} onClick={() => onCommit(stepValue(value, -1))}>−</button>
        <input key={value} class={muted ? 'ui-input ui-mono ui-input-muted' : 'ui-input ui-mono'} data-testid={`${id}-input`} defaultValue={value} placeholder={placeholder} disabled={off} aria-label={label} {...commitHandlers(value, onCommit)} />
        <button type="button" class="ui-stepper-btn" aria-label={`Increase ${label}`} data-testid={`${id}-plus`} disabled={off || !steppable} onClick={() => onCommit(stepValue(value, 1))}>+</button>
      </span>
    </label>
  );
}
