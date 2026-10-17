import type { ComponentChildren, JSX } from 'preact';

export interface SheetProps {
  open: boolean;
  side: 'right' | 'bottom';
  label: string;
  width?: number;
  maxHeight?: string;
  onClose(): void;
  children: ComponentChildren;
  'data-testid'?: string;
}

/** A floating panel docked to the right edge or the bottom. It sits over the canvas; it never resizes it. */
export function SheetView({ open, side, label, width, maxHeight, onClose, children, 'data-testid': id = 'sheet' }: SheetProps): JSX.Element | null {
  if (!open) return null;
  const style = side === 'right' ? (width ? `width:${width}px` : undefined) : maxHeight ? `max-height:${maxHeight}` : undefined;
  return (
    <section class={`ui-sheet ui-sheet-${side}`} aria-label={label} data-testid={id} style={style} onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" class={`ui-sheet-handle ui-sheet-handle-${side}`} aria-label={`Close ${label}`} data-testid={`${id}-close`} onClick={onClose} />
      <div class="ui-sheet-body">{children}</div>
    </section>
  );
}

export const Sheet = SheetView;
