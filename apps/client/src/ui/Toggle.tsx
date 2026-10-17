import type { JSX } from 'preact';

export interface ToggleProps { checked: boolean; label: string; disabled?: boolean; onChange(checked: boolean): void; 'data-testid'?: string }

export function Toggle({ checked, label, disabled, onChange, 'data-testid': id = 'toggle' }: ToggleProps): JSX.Element {
  return (
    <button type="button" role="switch" aria-checked={checked ? 'true' : 'false'} class="ui-toggle" data-testid={id} disabled={disabled} onClick={() => onChange(!checked)}>
      <span class="ui-toggle-track"><span class="ui-toggle-knob" /></span>
      <span>{label}</span>
    </button>
  );
}
