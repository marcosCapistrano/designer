import type { JSX } from 'preact';
import type { ToastItem } from './toasts.js';

export interface ToastStackProps { toasts: readonly ToastItem[]; onDismiss(id: number): void }

export function ToastStack({ toasts, onDismiss }: ToastStackProps): JSX.Element {
  return (
    <div class="ui-toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} class={`ui-toast ui-toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'} data-testid={`toast-${toast.id}`}>
          <span class="ui-toast-text">{toast.text}</span>
          {toast.action && (
            <button type="button" class="ui-toast-action" data-testid={`toast-${toast.id}-action`} onClick={toast.action.run}>{toast.action.label}</button>
          )}
          {toast.sticky && (
            <button type="button" class="ui-toast-dismiss" aria-label="Dismiss" data-testid={`toast-${toast.id}-dismiss`} onClick={() => onDismiss(toast.id)}>×</button>
          )}
        </div>
      ))}
    </div>
  );
}
