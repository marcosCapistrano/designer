// The menu a tap on a frame's label opens: set the frame's size, add a frame to
// its page, duplicate it, or delete it. Every change is a whole new layout
// handed to onChange. FrameMenuView is a pure function of its props and the
// custom-size draft, so tests can read it without a DOM; FrameMenu keeps the draft.

import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
  FRAME_GAP,
  FRAME_PRESETS,
  FRAME_VIEWPORT_MAX,
  FRAME_VIEWPORT_MIN,
  FRAME_WIDTH_MAX,
  FRAME_WIDTH_MIN,
  MAX_FRAMES_PER_APP,
  MAX_FRAMES_PER_PAGE,
} from '@hub/protocol';
import type { CanvasFrame, FrameSize } from '@hub/protocol';
import { randomFrameId } from './frames.js';

export interface FrameMenuProps {
  frame: CanvasFrame;
  frames: readonly CanvasFrame[];
  onChange(frames: CanvasFrame[]): void;
  onClose(): void;
}

/** The custom size fields as typed, and why the last Apply was refused. */
export interface MenuDraft {
  width: string;
  height: string;
  error: string | null;
}

const BUTTON =
  'font:inherit;min-height:44px;min-width:44px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text);cursor:pointer';
const BUTTON_OFF = BUTTON + ';opacity:.45;cursor:default';
const HEADING = 'margin:10px 0 4px;font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase';
const GRID = 'display:flex;flex-wrap:wrap;gap:6px';
const INPUT = 'font:inherit;min-height:44px;box-sizing:border-box;width:84px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text)';

const presetLabel = (p: FrameSize): string => `${p.width} × ${p.viewportHeight}`;
const presetKey = (p: FrameSize): string => `${p.width}x${p.viewportHeight}`;

function integerIn(text: string, lo: number, hi: number): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= lo && n <= hi ? n : null;
}

/** The size typed into the custom fields, or the message that says which limit it breaks. */
export function parseCustomSize(width: string, height: string): FrameSize | string {
  const w = integerIn(width, FRAME_WIDTH_MIN, FRAME_WIDTH_MAX);
  if (w === null) return `Width must be ${FRAME_WIDTH_MIN}–${FRAME_WIDTH_MAX}`;
  const h = integerIn(height, FRAME_VIEWPORT_MIN, FRAME_VIEWPORT_MAX);
  if (h === null) return `Height must be ${FRAME_VIEWPORT_MIN}–${FRAME_VIEWPORT_MAX}`;
  return { width: w, viewportHeight: h };
}

export function resizeFrame(frames: readonly CanvasFrame[], frame: CanvasFrame, size: FrameSize): CanvasFrame[] {
  return frames.map((f) => (f.id === frame.id ? { ...f, width: size.width, viewportHeight: size.viewportHeight } : f));
}

/** `frames` plus a frame of `size` on `frame`'s page, to the right of the page's rightmost frame, at `frame`'s y. */
export function addFrame(
  frames: readonly CanvasFrame[],
  frame: CanvasFrame,
  size: FrameSize,
  newId: () => string = randomFrameId,
): CanvasFrame[] {
  const right = Math.max(...frames.filter((f) => f.pageId === frame.pageId).map((f) => f.x + f.width));
  return [...frames, { id: newId(), pageId: frame.pageId, x: right + FRAME_GAP, y: frame.y, ...size }];
}

/** `frames` plus a copy of `frame`, placed to the right of the page's rightmost frame. */
export function duplicateFrame(frames: readonly CanvasFrame[], frame: CanvasFrame, newId?: () => string): CanvasFrame[] {
  return addFrame(frames, frame, { width: frame.width, viewportHeight: frame.viewportHeight }, newId);
}

export function deleteFrame(frames: readonly CanvasFrame[], frame: CanvasFrame): CanvasFrame[] {
  return frames.filter((f) => f.id !== frame.id);
}

export interface FrameMenuViewProps extends FrameMenuProps {
  draft: MenuDraft;
  setDraft(d: MenuDraft): void;
}

export function FrameMenuView({ frame, frames, onChange, onClose, draft, setDraft }: FrameMenuViewProps): JSX.Element {
  const onPage = frames.filter((f) => f.pageId === frame.pageId).length;
  const pageFull = onPage >= MAX_FRAMES_PER_PAGE;
  const appFull = frames.length >= MAX_FRAMES_PER_APP;
  const canAdd = !pageFull && !appFull;
  const full = pageFull ? `${MAX_FRAMES_PER_PAGE} frames per page` : appFull ? `${MAX_FRAMES_PER_APP} frames per app` : null;
  const canDelete = onPage > 1;

  const apply = (): void => {
    const size = parseCustomSize(draft.width, draft.height);
    if (typeof size === 'string') setDraft({ ...draft, error: size });
    else onChange(resizeFrame(frames, frame, size));
  };

  return (
    <div data-testid="frame-menu" style="padding:8px 10px 10px;font-size:14px;color:var(--text)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <strong>Frame</strong>
        <button type="button" data-testid="menu-close" aria-label="Close" style={BUTTON} onClick={onClose}>
          Close
        </button>
      </div>

      <div style={HEADING}>Size</div>
      <div style={GRID}>
        {FRAME_PRESETS.map((p) => (
          <button
            key={presetKey(p)}
            type="button"
            data-testid={`size-${presetKey(p)}`}
            style={BUTTON}
            onClick={() => onChange(resizeFrame(frames, frame, p))}
          >
            {presetLabel(p)}
          </button>
        ))}
      </div>
      <div style={GRID + ';margin-top:6px;align-items:center'}>
        <input
          data-testid="custom-width"
          type="number"
          inputMode="numeric"
          aria-label="Width"
          placeholder="Width"
          style={INPUT}
          value={draft.width}
          onInput={(e) => setDraft({ ...draft, width: (e.currentTarget as HTMLInputElement).value, error: null })}
        />
        <span>×</span>
        <input
          data-testid="custom-height"
          type="number"
          inputMode="numeric"
          aria-label="Height"
          placeholder="Height"
          style={INPUT}
          value={draft.height}
          onInput={(e) => setDraft({ ...draft, height: (e.currentTarget as HTMLInputElement).value, error: null })}
        />
        <button type="button" data-testid="custom-apply" style={BUTTON} onClick={apply}>
          Apply
        </button>
      </div>
      {draft.error !== null && (
        <div data-testid="custom-error" role="alert" style="margin-top:4px;color:var(--danger);font-size:13px">
          {draft.error}
        </div>
      )}

      <div style={HEADING}>Add frame</div>
      <div style={GRID}>
        {FRAME_PRESETS.map((p) => (
          <button
            key={presetKey(p)}
            type="button"
            data-testid={`add-${presetKey(p)}`}
            disabled={!canAdd}
            style={canAdd ? BUTTON : BUTTON_OFF}
            onClick={() => canAdd && onChange(addFrame(frames, frame, p))}
          >
            {presetLabel(p)}
          </button>
        ))}
      </div>
      {full !== null && (
        <div data-testid="add-note" style="margin-top:4px;color:var(--text-2);font-size:13px">
          {full}
        </div>
      )}

      <div style={GRID + ';margin-top:10px'}>
        <button
          type="button"
          data-testid="duplicate"
          disabled={!canAdd}
          style={canAdd ? BUTTON : BUTTON_OFF}
          onClick={() => canAdd && onChange(duplicateFrame(frames, frame))}
        >
          Duplicate
        </button>
        <button
          type="button"
          data-testid="delete"
          disabled={!canDelete}
          style={canDelete ? BUTTON + ';color:var(--danger)' : BUTTON_OFF + ';color:var(--danger)'}
          onClick={() => canDelete && onChange(deleteFrame(frames, frame))}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

export function FrameMenu(props: FrameMenuProps): JSX.Element {
  const [draft, setDraft] = useState<MenuDraft>({ width: String(props.frame.width), height: String(props.frame.viewportHeight), error: null });
  return <FrameMenuView {...props} draft={draft} setDraft={setDraft} />;
}
