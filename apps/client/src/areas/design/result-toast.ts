// Which toast an edit result shows. Inspector edits are confirmed by the field itself, so only their warnings
// toast; previews are confirmed by the banner.
import type { DesignEditResult } from '@hub/protocol';
import type { ToastInput } from '../../ui/toasts.js';

export type ResultOrigin = 'inspector' | 'chat' | 'apply' | 'undo' | 'redo';

const DONE: Record<Exclude<ResultOrigin, 'inspector'>, string> = { chat: 'Design updated.', apply: 'Design updated.', undo: 'Undone.', redo: 'Redone.' };

export function resultToast(result: DesignEditResult, origin: ResultOrigin): ToastInput | null {
  if (result.mode === 'preview') return null;
  const warnings = result.warnings.join(' ');
  if (origin === 'inspector') return warnings ? { kind: 'warning', text: warnings } : null;
  return { kind: 'ok', text: warnings ? `${DONE[origin]} ${warnings}` : DONE[origin] };
}
