import type { ComponentChildren, JSX } from 'preact';

export interface IconButtonProps {
  label: string;
  icon: ComponentChildren;
  onClick?: () => void;
  disabled?: boolean;
  pressed?: boolean;
  'data-testid'?: string;
}

/** A 44 px square button whose label is its accessible name and tooltip. */
export function IconButton({ label, icon, onClick, disabled, pressed, 'data-testid': id }: IconButtonProps): JSX.Element {
  return (
    <button
      type="button"
      class={pressed ? 'ui-icon-button ui-icon-button-on' : 'ui-icon-button'}
      aria-label={label}
      title={label}
      aria-pressed={pressed === undefined ? undefined : pressed ? 'true' : 'false'}
      disabled={disabled}
      onClick={onClick}
      data-testid={id}
    >
      {icon}
    </button>
  );
}
