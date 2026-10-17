import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { ImportRequest, ImportResponse, SourcePreviewProposal } from '@hub/protocol';
import type { ApiClient } from '../../net/api.js';
import type { TileSource } from '../../canvas/source.js';
import { createNullCache } from '../../canvas/cache.js';
import { CanvasView, MemoryFrameStore } from '../../canvas/index.js';
interface Props { app:string;api:ApiClient;source:TileSource;request:ImportRequest;disabled:boolean;onBusy:(busy:boolean)=>void;onImported:(result:ImportResponse)=>void }
export function SourceSamples({app,api,source,request,disabled,onBusy,onImported}:Props):JSX.Element {
  const [busy,setBusy] = useState(false);
  const [proposal,setProposal] = useState<SourcePreviewProposal|null>(null);
  const [accepted,setAccepted] = useState(0);
  const [error,setError] = useState<string|null>(null);
  const [preferences,setPreferences]=useState('');
  const ownRequest=useRef(false);
  const cache = useMemo(()=>createNullCache(),[]);
  // The samples' pages are not in the design yet, so the preview shows them in the default layout.
  const previewFrames = useMemo(()=>proposal?.manifest?new MemoryFrameStore(proposal.manifest):null,[proposal]);
  const previewSource = useMemo<TileSource|null>(()=>proposal?.manifest?{manifest:async()=>proposal.manifest!,tile:(key,x,y)=>source.tile(key,x,y),hitMap:(key)=>source.hitMap(key),subscribe:()=>()=>{}}:null,[proposal,source]);
  useEffect(()=>{onBusy(busy)},[busy,onBusy]);
  useEffect(()=>{let active=true;void api.sourcePreview(app).then(state=>{if(active){setBusy(state.running);setProposal(state.proposal);setAccepted(state.acceptedSamples)}}).catch(()=>{});return()=>{active=false}},[app,api]);
  useEffect(()=>{
    if(!busy||ownRequest.current)return;
    let active=true;const timer=setInterval(()=>{void api.sourcePreview(app).then(state=>{if(active){setBusy(state.running);setProposal(state.proposal);setAccepted(state.acceptedSamples)}}).catch(()=>{})},1000);
    return()=>{active=false;clearInterval(timer)};
  },[busy,app,api]);
  const generate = async()=>{
    ownRequest.current=true;setBusy(true);setError(null);
    try { const result=await api.generateSourcePreview(app,request,preferences.trim()||undefined);if(result.ok)setProposal(result.proposal);else onImported(result); }
    catch(error){setError(error instanceof Error?error.message:'Preview generation failed.')}
    finally{ownRequest.current=false;setBusy(false)}
  };
  const apply=async()=>{
    if(!proposal)return;ownRequest.current=true;setBusy(true);setError(null);
    try{const result=await api.applySourcePreview(app,proposal.id);onImported(result);if(result.ok){setAccepted(proposal.samples.length);setProposal(null)}}
    catch(error){setError(error instanceof Error?error.message:'Preview import failed.')}
    finally{ownRequest.current=false;setBusy(false)}
  };
  return <section class="design-samples" aria-label="Source preview samples">
    <label>Preview state or sample data <input value={preferences} maxLength={4000} placeholder="e.g. Expanded view with three sample items" disabled={busy||disabled} onInput={event=>setPreferences(event.currentTarget.value)}/></label>
    <button class="shell-button" disabled={disabled||busy} onClick={()=>void generate()}>{busy?'Choosing samples…':'Generate sample preview'}</button>
    {busy&&<button class="shell-button" onClick={()=>void api.stopSourcePreview(app)}>Stop sample generation</button>}
    {accepted>0&&<span>Preview uses {accepted} saved sample choices.</span>}
    {error&&<p role="alert">{error}</p>}
    {proposal&&<div class="design-sample-proposal" role="region" aria-label="Source sample preview">
      <h2>Review preview samples</h2><p>These are representative preview values, not live app data. Apply saves them for future imports.</p>
      {proposal.samples.map((sample,index)=><details key={index}><summary>{sample.file}: {sample.expression.slice(0,120)}</summary><pre>{JSON.stringify(sample.value,null,2)}</pre></details>)}
      {proposal.warnings.length>0&&<p role="alert">{proposal.warnings.join(' ')}</p>}
      {previewSource&&previewFrames&&<div class="design-source-preview"><CanvasView key={proposal.id} source={previewSource} cache={cache} frames={previewFrames}/></div>}
      <button class="shell-button" disabled={busy||disabled} onClick={()=>void apply()}>Apply samples and import</button>
      <button class="shell-button" disabled={busy} onClick={()=>void api.cancelSourcePreview(app,proposal.id).then(()=>setProposal(null)).catch(error=>setError(String(error)))}>Cancel samples</button>
    </div>}
  </section>;
}
