import type { ComponentChildren, JSX } from 'preact';

export interface ButtonProps {
  kind?: 'primary' | 'quiet' | 'danger';
  type?: 'button' | 'submit';
  disabled?: boolean;
  busy?: boolean;
  onClick?: () => void;
  children: ComponentChildren;
  'data-testid'?: string;
}

export function Button({ kind = 'quiet', type = 'button', disabled, busy, onClick, children, 'data-testid': id }: ButtonProps): JSX.Element {
  return (
    <button type={type} class={`ui-button ui-button-${kind}`} disabled={Boolean(disabled || busy)} onClick={onClick} data-testid={id}>
      {busy && <span class="ui-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}
