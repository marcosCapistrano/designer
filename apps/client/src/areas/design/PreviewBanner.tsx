// Shown over the canvas while a proposal is previewed there: what would change, and Apply or Cancel.
import type { JSX } from 'preact';
import type { DesignProposal } from '@hub/protocol';
import { Button } from '../../ui/Button.js';

export interface PreviewBannerProps { proposal: DesignProposal; busy: boolean; onApply(): void; onCancel(): void }

export function PreviewBanner({ proposal, busy, onApply, onCancel }: PreviewBannerProps): JSX.Element {
  return (
    <section id="preview-banner" tabIndex={-1} class="design-preview-banner" role="region" aria-label="Previewed changes" data-testid="preview-banner" onPointerDown={(e) => e.stopPropagation()}>
      <div class="design-preview-text">
        <strong>Preview</strong>
        <ul>{proposal.descriptions.map((d, i) => <li key={i}>{d}</li>)}</ul>
        {proposal.warnings.length > 0 && <p class="design-preview-warning" role="alert">{proposal.warnings.join(' ')}</p>}
      </div>
      <div class="design-preview-actions">
        <Button onClick={onCancel} disabled={busy} data-testid="preview-cancel">Cancel preview</Button>
        <Button kind="primary" onClick={onApply} busy={busy} data-testid="preview-apply">Apply changes</Button>
      </div>
    </section>
  );
}
