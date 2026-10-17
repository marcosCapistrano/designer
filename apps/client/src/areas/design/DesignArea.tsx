import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { ImportDiagnostic, ImportResponse, NodeSelection } from '@hub/protocol';
import type { ApiClient } from '../../net/api.js';
import { ServerFrameStore } from '../../net/frame-store.js';
import type { WsClient } from '../../net/ws.js';
import type { BlobCache } from '../../canvas/cache.js';
import type { TileSource } from '../../canvas/source.js';
import { CanvasView } from '../../canvas/index.js';
import './design.css';
import { EditorPanel } from './EditorPanel.js';
import { SourceSamples } from './SourceSamples.js';
import { importNote } from './import-result.js';

const Diagnostics = ({ items }: { items: ImportDiagnostic[] }) => <ul>{items.map((diagnostic, index) => <li key={index}>{diagnostic.file && `${diagnostic.file}: `}{diagnostic.message}</li>)}</ul>;

export interface DesignAreaProps { app: string; api: ApiClient; ws: WsClient; source: TileSource; cache: BlobCache }
export function DesignArea({ app, api, ws, source, cache }: DesignAreaProps): JSX.Element {
  const [mode, setMode] = useState<'next' | 'react'>('next');
  const [file, setFile] = useState('src/App.tsx');
  const [route, setRoute] = useState('/');
  const [appDir, setAppDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [selection, setSelection] = useState<NodeSelection | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [sampleBusy,setSampleBusy]=useState(false);
  const frames = useMemo(() => new ServerFrameStore(app, api), [app, api]);
  const imported=useCallback((out:ImportResponse)=>{setResult(out);if(out.ok){setRevision(out.revision);setSelection(null);setNote(importNote(out));setPreviewVersion(value=>value+1)}},[]);
  const edited = useCallback((next: string, warnings: string[]) => { setRevision(next); setNote(warnings.join(' ') || 'Design updated.'); setPreviewVersion((value) => value + 1); setSelection(null); }, []);
  useEffect(() => { let active = true; void api.designSummary(app).then((summary) => { if (active) setRevision((current) => current ?? summary.revision); }).catch(() => {}); return () => { active = false; }; }, [app, api]);
  useEffect(() => {
    let active = true;
    const off = ws.on((message) => { if (message.type === 'build.task' && message.app === app) setBuilding(message.running); });
    void api.buildState(app).then((state) => { if (active) setBuilding(state.running); }).catch(() => {});
    return () => { active = false; off(); };
  }, [app, api, ws]);
  const importPages = async () => {
    setBusy(true); setError(null); setNote(null);
    try {
      const out = await api.importPages(app, mode === 'next' ? { mode, ...(appDir.trim() ? { appDir: appDir.trim() } : {}) } : { mode, entries: [{ route: route.trim(), file: file.trim() }] });
      imported(out);
    } catch (error) { setError(error instanceof Error ? error.message : 'Import failed.'); }
    finally { setBusy(false); }
  };
  const retry = async () => {
    setBusy(true); setError(null);
    try { const out = await api.retryPreview(app); setNote(out.warnings.join(' ') || 'Preview updated.'); setPreviewVersion((value) => value + 1); }
    catch (error) { setError(error instanceof Error ? error.message : 'Preview failed.'); }
    finally { setBusy(false); }
  };
  return <div class="design-area">
    <form class="design-import" onSubmit={(event) => { event.preventDefault(); void importPages(); }}>
      <label>Source <select value={mode} disabled={busy} onChange={(event) => setMode(event.currentTarget.value as 'next' | 'react')}><option value="next">Next App Router</option><option value="react">React page</option></select></label>
      {mode === 'next' ? <label>App directory <input placeholder="Auto: app or src/app" value={appDir} disabled={busy} onInput={(event) => setAppDir(event.currentTarget.value)} /></label> : <>
        <label>Entry file <input value={file} required disabled={busy} onInput={(event) => setFile(event.currentTarget.value)} /></label>
        <label>Route <input value={route} required disabled={busy} onInput={(event) => setRoute(event.currentTarget.value)} /></label>
      </>}
      <button class="shell-button" type="submit" disabled={busy || building || sampleBusy}>{busy ? 'Working…' : 'Import pages'}</button>
      <button class="shell-button" type="button" disabled={busy || building || sampleBusy} onClick={() => void retry()}>Retry preview</button>
    </form>
    <SourceSamples app={app} api={api} source={source} request={mode==='next'?{mode,...(appDir.trim()?{appDir:appDir.trim()}:{})}:{mode,entries:[{route:route.trim(),file:file.trim()}]}} disabled={busy||building} onBusy={setSampleBusy} onImported={imported}/>
    {building && <p class="design-status">Wait for Build to finish before importing.</p>}
    {note && <p class="design-status" role="status">{note}</p>}
    {error && <p class="design-status" role="alert">{error}</p>}
    {result && !result.ok && <div class="design-status" role="alert">
      <p>Import was not applied. Your previous design and edits are preserved.</p>
      {result.kind === 'source' ? <Diagnostics items={result.diagnostics} /> : <ul>{result.conflicts.map((conflict) => <li key={conflict.index}>Edit {conflict.index + 1}: {conflict.message}</li>)}<li>{result.blocked.length} later edits are blocked.</li></ul>}
    </div>}
    {result?.ok && result.failed.length > 0 && <div class="design-status" role="alert">
      <p>These routes were not imported. Each keeps its previous version, if it had one.</p>
      <ul>{result.failed.map((failure) => <li key={failure.route}>{failure.route}<Diagnostics items={failure.diagnostics} /></li>)}</ul>
    </div>}
    {result?.ok && result.warnings.length > 0 && <p class="design-status" role="alert">{result.warnings.join(' ')}</p>}
    <div class="design-workspace"><div class="design-canvas"><CanvasView key={previewVersion} source={source} cache={cache} frames={frames} onSelect={setSelection} />
      {!revision && <div class="design-empty">Import your pages to start designing.</div>}
    </div>
      <EditorPanel app={app} api={api} ws={ws} source={source} selection={selection} revision={revision} disabled={busy || building || sampleBusy} onApplied={edited} />
    </div>
  </div>;
}
