import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';

export interface MenuItem { label: string; run(): void; disabled?: boolean; 'data-testid'?: string }
export interface MenuProps { label: string; icon?: ComponentChildren; items: readonly MenuItem[]; disabled?: boolean; 'data-testid'?: string }
export interface MenuViewProps extends MenuProps { open: boolean; setOpen(open: boolean): void }

export function MenuView({ label, icon = '⋯', items, disabled, open, setOpen, 'data-testid': id = 'menu' }: MenuViewProps): JSX.Element {
  return (
    <div class="ui-menu" onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" class="ui-icon-button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open ? 'true' : 'false'} data-testid={id} disabled={disabled} onClick={() => setOpen(!open)}>
        {icon}
      </button>
      {open && <>
        <div class="ui-menu-scrim" onClick={() => setOpen(false)} />
        <ul class="ui-menu-list" role="menu">
          {items.map((item) => (
            <li key={item.label} role="none">
              <button type="button" role="menuitem" class="ui-menu-item" disabled={item.disabled} data-testid={item['data-testid']} onClick={() => { setOpen(false); item.run(); }}>
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
