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

/** The layers panel docks as a left column this wide at and above the breakpoint; below, it is a sheet over the canvas. */
export const LAYERS_BREAKPOINT = 1200;
export const LAYERS_WIDTH = 280;

export const layersLayout = (width: number): 'docked' | 'sheet' => (width >= LAYERS_BREAKPOINT ? 'docked' : 'sheet');

/** The chrome fits keep clear of: the top and bottom bars, plus a docked layers column while it is open. */
export function canvasInsets(width: number, layersOpen: boolean): { top: number; right: number; bottom: number; left: number } {
  return { ...CANVAS_INSETS, left: layersOpen && layersLayout(width) === 'docked' ? LAYERS_WIDTH : 0 };
}
