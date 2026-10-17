// Import pages (and sample preview) in a modal, out of the canvas's way. Requests are the same as before.
import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { ImportRequest, ImportResponse } from '@hub/protocol';
import type { ApiClient } from '../../net/api.js';
import type { TileSource } from '../../canvas/source.js';
import { Button } from '../../ui/Button.js';
import { Modal } from '../../ui/Modal.js';
import { SourceSamples } from './SourceSamples.js';

export type ImportMode = 'next' | 'react';

export function importRequest(mode: ImportMode, appDir: string, file: string, route: string): ImportRequest {
  return mode === 'next'
    ? { mode, ...(appDir.trim() ? { appDir: appDir.trim() } : {}) }
    : { mode, entries: [{ route: route.trim(), file: file.trim() }] };
}

export interface ImportFormViewProps {
  mode: ImportMode;
  appDir: string;
  file: string;
  route: string;
  busy: boolean;
  disabled: boolean;
  onMode(mode: ImportMode): void;
  onAppDir(v: string): void;
  onFile(v: string): void;
  onRoute(v: string): void;
  onImport(): void;
  onRetry(): void;
}

const value = (e: Event): string => (e.currentTarget as HTMLInputElement).value;

export function ImportFormView(p: ImportFormViewProps): JSX.Element {
  const off = p.busy || p.disabled;
  return (
    <form class="design-import-form" onSubmit={(e) => { e.preventDefault(); if (!off) p.onImport(); }}>
      <label class="ui-field"><span class="ui-field-label">Source</span>
        <select class="ui-select" data-testid="import-mode" value={p.mode} disabled={off} onChange={(e) => p.onMode(value(e) as ImportMode)}>
          <option value="next">Next App Router</option>
          <option value="react">React page</option>
        </select>
      </label>
      {p.mode === 'next'
        ? <label class="ui-field"><span class="ui-field-label">App directory</span><input class="ui-input" data-testid="import-appdir" placeholder="Auto: app or src/app" value={p.appDir} disabled={off} onInput={(e) => p.onAppDir(value(e))} /></label>
        : <>
          <label class="ui-field"><span class="ui-field-label">Entry file</span><input class="ui-input" data-testid="import-file" required value={p.file} disabled={off} onInput={(e) => p.onFile(value(e))} /></label>
          <label class="ui-field"><span class="ui-field-label">Route</span><input class="ui-input" data-testid="import-route" required value={p.route} disabled={off} onInput={(e) => p.onRoute(value(e))} /></label>
        </>}
      <div class="design-import-actions">
        <Button onClick={p.onRetry} disabled={off} data-testid="import-retry">Retry preview</Button>
        <Button kind="primary" type="submit" busy={p.busy} disabled={p.disabled} data-testid="import-submit">Import pages</Button>
      </div>
    </form>
  );
}

export interface ImportSheetProps {
  open: boolean;
  onClose(): void;
  app: string;
  api: ApiClient;
  source: TileSource;
  /** Build is running or another design action is in flight. */
  disabled: boolean;
  onImported(out: ImportResponse): void;
  onRetried(warnings: string[]): void;
  onError(message: string): void;
  onSampleBusy(busy: boolean): void;
}

export function ImportSheet({ open, onClose, app, api, source, disabled, onImported, onRetried, onError, onSampleBusy }: ImportSheetProps): JSX.Element {
  const [mode, setMode] = useState<ImportMode>('next');
  const [appDir, setAppDir] = useState('');
  const [file, setFile] = useState('src/App.tsx');
  const [route, setRoute] = useState('/');
  const [busy, setBusy] = useState(false);
  const run = async (task: () => Promise<void>, failure: string): Promise<void> => {
    setBusy(true);
    try { await task(); } catch (error) { onError(error instanceof Error ? error.message : failure); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} title="Import pages" onClose={onClose} data-testid="import-sheet">
      <ImportFormView mode={mode} appDir={appDir} file={file} route={route} busy={busy} disabled={disabled}
        onMode={setMode} onAppDir={setAppDir} onFile={setFile} onRoute={setRoute}
        onImport={() => void run(async () => { const out = await api.importPages(app, importRequest(mode, appDir, file, route)); onImported(out); if (out.ok) onClose(); }, 'Import failed.')}
        onRetry={() => void run(async () => { const out = await api.retryPreview(app); onRetried(out.warnings); onClose(); }, 'Preview failed.')} />
      <hr class="design-import-divider" />
      <SourceSamples app={app} api={api} source={source} request={importRequest(mode, appDir, file, route)} disabled={disabled || busy} onBusy={onSampleBusy} onImported={onImported} />
    </Modal>
  );
}
