import { useEffect, useMemo, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { DesignEditResult, DesignProposal, DesignSelection, NodeSelection } from '@hub/protocol';
import type { ApiClient } from '../../net/api.js';
import { CanvasView } from '../../canvas/index.js';
import { createNullCache } from '../../canvas/cache.js';
import type { TileSource } from '../../canvas/source.js';

interface Props { app: string; api: ApiClient; source: TileSource; selection: NodeSelection | null; revision: string | null; disabled: boolean; onApplied: (revision: string, warnings: string[]) => void }
export function EditorPanel({ app, api, source, selection, revision, disabled, onApplied }: Props): JSX.Element {
  const [info, setInfo] = useState<DesignSelection | null>(null);
  const [targetId, setTargetId] = useState('');
  const [property, setProperty] = useState('color');
  const [value, setValue] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<DesignProposal | null>(null);
  const previewCache = useMemo(() => createNullCache(), []);
  const previewSource = useMemo<TileSource | null>(() => proposal?.manifest ? {
    manifest: async () => proposal.manifest!, tile: (key, x, y) => source.tile(key, x, y), hitMap: (hash) => source.hitMap(hash), subscribe: () => () => {},
  } : null, [proposal, source]);
  useEffect(() => {
    let active = true;
    setInfo(null); setError(null);
    if (selection) void api.designSelection(app, selection).then((next) => {
      if (!active) return;
      setInfo(next); setTargetId(next.targets[0]?.id ?? ''); setText(next.targets[0]?.text ?? '');
    }).catch((error) => { if (active) setError(error instanceof Error ? error.message : 'Selection could not be read.'); });
    return () => { active = false; };
  }, [api, app, selection, revision]);
  const target = info?.targets.find((item) => item.id === targetId);
  const acceptResult = (result: DesignEditResult) => {
    if (result.mode === 'preview') setProposal(result.proposal);
    else { setProposal(null); onApplied(result.revision, result.warnings); }
  };
  const action = async (run: () => Promise<DesignEditResult>) => {
    setBusy(true); setError(null);
    try { acceptResult(await run()); }
    catch (error) { setError(error instanceof Error ? error.message : 'Edit failed.'); }
    finally { setBusy(false); }
  };
  const edit = (ops: unknown[]) => { if (info) void action(() => api.editDesign(app, info.revision, ops, info.selection)); };
  const locked = disabled || busy;
  return <section class="design-editor" aria-label="Element editor">
    <div class="design-editor-actions">
      <button class="shell-button" disabled={locked || !revision} onClick={() => revision && void action(() => api.designHistory(app, revision, 'undo'))}>Undo</button>
      <button class="shell-button" disabled={locked || !revision} onClick={() => revision && void action(() => api.designHistory(app, revision, 'redo'))}>Redo</button>
    </div>
    {!selection && <p>Choose Select on the canvas, then tap an element to edit it.</p>}
    {info && target && <>
      <label>Edit target <select value={targetId} disabled={locked} onChange={(event) => { const id = event.currentTarget.value; setTargetId(id); setText(info.targets.find((item) => item.id === id)?.text ?? ''); }}>
        {info.targets.map((item) => <option key={item.id} value={item.id}>{item.shared ? 'Shared component' : 'This page'} · {item.tag ?? item.component ?? item.kind}</option>)}
      </select></label>
      {target.shared && <p>Changes to this definition affect every linked instance and require a preview.</p>}
      {target.kind !== 'text' && <form onSubmit={(event) => { event.preventDefault(); edit([{ op: 'setStyle', node: target.id, device: info.selection.device, prop: property.trim(), value: value.trim() || null }]); }}>
        <label>CSS property <input value={property} required disabled={locked} onInput={(event) => setProperty(event.currentTarget.value)} /></label>
        <label>Value ({info.selection.device === 'base' ? 'Desktop' : info.selection.device}) <input value={value} placeholder="Blank removes the override" disabled={locked} onInput={(event) => setValue(event.currentTarget.value)} /></label>
        <button class="shell-button" disabled={locked}>Set style</button>
      </form>}
      {target.textNode && <form onSubmit={(event) => { event.preventDefault(); edit([{ op: 'setText', node: target.textNode, text }]); }}>
        <label>Text <input value={text} disabled={locked} onInput={(event) => setText(event.currentTarget.value)} /></label>
        <button class="shell-button" disabled={locked}>Set text</button>
      </form>}
      {target.declaredProps && Object.entries(target.declaredProps).map(([name, current]) => <form key={name} onSubmit={(event) => {
        event.preventDefault(); const field = event.currentTarget.elements.namedItem('prop') as HTMLInputElement;
        edit([{ op: 'setInstanceProp', node: target.id, prop: name, value: field.value }]);
      }}><label>{name} <input name="prop" defaultValue={current} disabled={locked} /></label><button class="shell-button" disabled={locked}>Set {name}</button></form>)}
    </>}
    {proposal && <div class="design-proposal" role="region" aria-label="Edit preview">
      <h2>Review changes</h2><ul>{proposal.descriptions.map((description, index) => <li key={index}>{description}</li>)}</ul>
      {proposal.warnings.length > 0 && <p role="alert">{proposal.warnings.join(' ')}</p>}
      {previewSource && <div class="design-preview-canvas"><CanvasView key={proposal.id} source={previewSource} cache={previewCache} /></div>}
      <button class="shell-button" disabled={locked} onClick={() => void action(() => api.applyDesign(app, proposal.id))}>Apply changes</button>
      <button class="shell-button" disabled={locked} onClick={() => { void api.cancelDesign(app, proposal.id).then(() => setProposal(null)).catch((error) => setError(String(error))); }}>Cancel preview</button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
