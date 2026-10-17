import { useEffect } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';

export interface ModalProps { open: boolean; title: string; onClose(): void; children: ComponentChildren; 'data-testid'?: string }

export function ModalView({ open, title, onClose, children, 'data-testid': id = 'modal' }: ModalProps): JSX.Element | null {
  if (!open) return null;
  return (
    <div class="ui-modal-layer" onPointerDown={(e) => e.stopPropagation()}>
      <div class="ui-modal-backdrop" data-testid={`${id}-backdrop`} onClick={onClose} />
      <section class="ui-modal" role="dialog" aria-modal="true" aria-label={title} data-testid={id}>
        <header class="ui-modal-header">
          <h2 class="ui-modal-title">{title}</h2>
          <button type="button" class="ui-icon-button" aria-label="Close" title="Close" data-testid={`${id}-close`} onClick={onClose}>×</button>
        </header>
        <div class="ui-modal-body">{children}</div>
      </section>
    </div>
  );
}

/** The dialog plus Escape to close while it is open. */
export function Modal(props: ModalProps): JSX.Element | null {
  const { open, onClose } = props;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return ModalView(props);
}
