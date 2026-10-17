// Where the floating panels go for a given width. Below the breakpoint the inspector becomes a bottom sheet and
// chat stays a full-width bar, so its send button is never covered.
export const INSPECTOR_BREAKPOINT = 900;
export const INSPECTOR_WIDTH = 360;

export interface PanelLayout { inspector: 'right' | 'bottom' | 'none'; chatDocked: boolean }

export function panelLayout(width: number, inspectorOpen: boolean): PanelLayout {
  if (!inspectorOpen) return { inspector: 'none', chatDocked: false };
  return width >= INSPECTOR_BREAKPOINT ? { inspector: 'right', chatDocked: true } : { inspector: 'bottom', chatDocked: false };
}

/** The top bar (56px) above, the chat bar (64px) and tool pill below: fits keep frames out from under them. */
export const CANVAS_INSETS = { top: 56, right: 0, bottom: 136, left: 0 } as const;
