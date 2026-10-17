import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';

/** `checked` on any item makes the menu a choice list, whose checked item is the current choice. */
export interface MenuItem { label: string; run(): void; disabled?: boolean; checked?: boolean; 'data-testid'?: string }
/** With `text`, the button shows that text (the current choice) instead of an icon. */
export interface MenuProps { label: string; icon?: ComponentChildren; text?: string; items: readonly MenuItem[]; disabled?: boolean; 'data-testid'?: string }
export interface MenuViewProps extends MenuProps { open: boolean; setOpen(open: boolean): void }

export function MenuView({ label, icon = '⋯', text, items, disabled, open, setOpen, 'data-testid': id = 'menu' }: MenuViewProps): JSX.Element {
  const choice = items.some((item) => item.checked !== undefined);
  return (
    <div class="ui-menu" onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" class={text === undefined ? 'ui-icon-button' : 'ui-menu-text'} aria-label={text === undefined ? label : `${label}: ${text}`} title={label} aria-haspopup="menu" aria-expanded={open ? 'true' : 'false'} data-testid={id} disabled={disabled} onClick={() => setOpen(!open)}>
        {text === undefined ? icon : <><span class="ui-menu-text-value">{text}</span><span class="ui-menu-caret" aria-hidden="true">▾</span></>}
      </button>
      {open && <>
        <div class="ui-menu-scrim" onClick={() => setOpen(false)} />
        <ul class="ui-menu-list" role="menu">
          {items.map((item) => (
            <li key={item.label} role="none">
              <button type="button" role={choice ? 'menuitemradio' : 'menuitem'} aria-checked={choice ? (item.checked ? 'true' : 'false') : undefined}
                class={item.checked ? 'ui-menu-item ui-menu-item-on' : 'ui-menu-item'} disabled={item.disabled} data-testid={item['data-testid']} onClick={() => { setOpen(false); item.run(); }}>
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </>}
    </div>
  );
}

/** The menu with its open state; Escape and a tap outside close it. */
export function Menu(props: MenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return MenuView({ ...props, open, setOpen });
}
