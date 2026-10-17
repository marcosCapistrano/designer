import { describe, expect, it } from 'vitest';
import { exportPage } from '@hub/design-model';
import { choiceKey, choicesProblem, extractPages, parseSyncState, serializeSyncState, synchronizePages } from './index.js';
const entry = [{ route: '/', file: 'page.tsx' }];
describe('saved source preview choices', () => {
  it('reports a stable missing gap and reuses accepted sample nodes with source-derived IDs', () => {
    const files = { 'page.tsx': 'export default () => <main>{renderItems()}</main>' };
    const missing = extractPages({ files },entry);
    expect(missing).toMatchObject({ ok: false, diagnostics: [{ gap: { kind: 'nodes', expression: 'renderItems()' } }] });
    if (missing.ok) return;
    const key = missing.diagnostics[0]!.gap!.key;
    const choices = { [key]: { kind: 'nodes' as const, nodes: [{ tag: 'p', style: { color: 'red' }, children: ['Sample item'] }] } };
    const imported = synchronizePages({ project: { files }, entries: entry, commit: 'one', choices });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(parseSyncState(serializeSyncState(imported.state))).toEqual({ ok: true, value: imported.state });
    const repeated = synchronizePages({ project: { files }, entries: entry, commit: 'two', previous: imported.state });
    expect(repeated.ok && repeated.reused).toEqual(['/']);
    const out = exportPage(imported.state.doc,Object.keys(imported.state.doc.pages)[0]!);
    expect(out.ok && out.value.html).toContain('Sample item');
    expect(out.ok && out.value.css).toContain('color:red');
    const changed = extractPages({ files: { 'page.tsx': `// unrelated comment\n${files['page.tsx']}` } },entry,{choices});
    expect(changed.ok && changed.doc.pages).toEqual(imported.state.doc.pages);
  });
  it('fills dynamic local data with JSON values while keeping resolvable JSX intact', () => {
    const files = { 'page.tsx': 'export default function Page() { const user = loadUser(); return <main>{user.name}</main>; }' };
    const first = extractPages({files},entry);
    if (first.ok) throw new Error('gap expected');
    expect(first.diagnostics[0]!.gap?.kind).toBe('value');
    const chosen = extractPages({files},entry,{choices:{[first.diagnostics[0]!.gap!.key]:{kind:'value',value:{name:'Alice'}}}});
    expect(chosen.ok).toBe(true);
    if (chosen.ok) expect(exportPage(chosen.doc,Object.keys(chosen.doc.pages)[0]!).ok).toBe(true);
  });
  it('never overrides an already statically resolvable expression with a stale choice', () => {
    const files = { 'page.tsx': 'const title = "Real"; export default () => <p>{title}</p>' };
    const result = extractPages({files},entry,{choices:{[choiceKey('page.tsx','title')]:{kind:'nodes',nodes:['Wrong']}}});
    expect(result.ok).toBe(true);
    if (result.ok) expect(exportPage(result.doc,Object.keys(result.doc.pages)[0]!)).toMatchObject({ ok:true, value:{html:expect.stringContaining('Real')} });
  });
  it('rejects unsafe sample nodes and prevents sample arrays from injecting model IDs', () => {
    const files = { 'page.tsx': 'export default () => <main>{dynamic()}</main>' };
    const key = choiceKey('page.tsx','dynamic()');
    expect(extractPages({files},entry,{choices:{[key]:{kind:'nodes',nodes:[{tag:'script',children:['bad']}]}}}).ok).toBe(false);
    const injected = extractPages({files},entry,{choices:{[key]:{kind:'value',value:[{id:'injected',kind:'text',text:'bad'}]}}});
    expect(injected).toMatchObject({ok:false,diagnostics:[{gap:{kind:'nodes'}}]});
  });
  it('invalidates old sampled expressions after source changes and rejects inconsistent snapshot choice hashes', () => {
    const files = { 'page.tsx': 'export default () => <p>{dynamic()}</p>' };
    const choices = { [choiceKey('page.tsx','dynamic()')]: {kind:'nodes' as const,nodes:['Sample']} };
    const first = synchronizePages({ project:{files},entries:entry,commit:'one',choices });
    if (!first.ok) throw new Error(JSON.stringify(first));
    expect(synchronizePages({project:{files:{'page.tsx':'export default () => <p>{different()}</p>'}},entries:entry,commit:'two',previous:first.state})).toMatchObject({ok:true,failed:[{route:'/',diagnostics:[{gap:{expression:'different()'}}]}]});
    const snapshot = serializeSyncState(first.state);
    const metadata = JSON.parse(snapshot['sync.json']!); metadata.choices[Object.keys(choices)[0]!].nodes = ['Changed'];
    snapshot['sync.json'] = JSON.stringify(metadata);
    expect(parseSyncState(snapshot)).toMatchObject({ok:false,error:expect.stringContaining('cached baseline')});
  });
  it('keeps source list templates and keyed IDs when sample data changes order', () => {
    const files={'page.tsx':'export default function Page(){ const rows=loadRows();return <main>{rows.map(row => <p key={row.id}>{row.name}</p>)}</main>; }'};
    const key=choiceKey('page.tsx','loadRows()');
    const first=extractPages({files},entry,{choices:{[key]:{kind:'value',value:[{id:'a',name:'Alice'},{id:'b',name:'Bob'}]}}});
    const second=extractPages({files},entry,{choices:{[key]:{kind:'value',value:[{id:'b',name:'Bob'},{id:'a',name:'Alice'}]}}});
    expect(first.ok&&second.ok).toBe(true);
    if(first.ok&&second.ok) {
      const children=Object.values(first.doc.pages)[0]!.root.children;
      expect(Object.values(second.doc.pages)[0]!.root.children.map(node=>node.id)).toEqual([children[1]!.id,children[0]!.id]);
    }
  });
  it('stores React state/branch choices and requires explicit non-execution acknowledgement for effects', () => {
    const files={'page.tsx':`import {useState,useEffect} from 'react';export default function Page(){const [open,setOpen]=useState(false);useEffect(()=>fetch('/api'),[]);return <main>{open?<p>Open</p>:<p>Closed</p>}</main>;}`};
    expect(extractPages({files},entry)).toMatchObject({ok:false,diagnostics:[{gap:{kind:'value',expression:'useState(false)'}}]});
    const result=extractPages({files},entry,{choices:{[choiceKey('page.tsx','useState(false)')]:{kind:'value',value:true},[choiceKey('page.tsx',"useEffect(()=>fetch('/api'),[])")]:{kind:'value',value:null}}});
    expect(result.ok).toBe(true);
    if(result.ok)expect(exportPage(result.doc,Object.keys(result.doc.pages)[0]!)).toMatchObject({ok:true,value:{html:expect.stringContaining('Open')}});
  });
  it('uses distinct branch IDs so pending edits cannot silently switch conditional targets', () => {
    const files={'page.tsx':`import {useState} from 'react';export default function Page(){const [open]=useState(false);return <main>{open?<p>Open</p>:<p>Closed</p>}</main>;}`};
    const key=choiceKey('page.tsx','useState(false)');
    const yes=extractPages({files},entry,{choices:{[key]:{kind:'value',value:true}}});
    const no=extractPages({files},entry,{choices:{[key]:{kind:'value',value:false}}});
    expect(yes.ok&&no.ok).toBe(true);
    if(yes.ok&&no.ok)expect(Object.values(yes.doc.pages)[0]!.root.children[0]!.id).not.toBe(Object.values(no.doc.pages)[0]!.root.children[0]!.id);
  });
  it('tracks local import graph CSS even when a branch does not render that component', () => {
    const files={'page.tsx':`import Unused from './unused';import './page.css';export default () => <main>{false?<Unused/>:<p>Visible</p>}</main>`, 'unused.tsx':`import './unused.css';export default () => <p>Unused</p>`, 'unused.css':'p { color: red; }', 'page.css':'p { color: blue; }'};
    const result=extractPages({files},entry);
    expect(result.ok).toBe(true);
    if(result.ok) {
      expect(result.dependencies[Object.keys(result.doc.pages)[0]!]).toEqual(Object.keys(files).sort());
      expect(exportPage(result.doc,Object.keys(result.doc.pages)[0]!)).toMatchObject({ok:true,value:{css:expect.stringContaining('color:blue')}});
    }
  });
  it('reads imported literal constants and does not guess values already available in source',()=>{
    const files={'page.tsx':`import {title} from './data';export default () => (<h1>{title}</h1> as unknown)`, 'data.ts':'export const title="From source";'};
    const result=extractPages({files},entry);
    expect(result.ok).toBe(true);
    if(result.ok)expect(exportPage(result.doc,Object.keys(result.doc.pages)[0]!)).toMatchObject({ok:true,value:{html:expect.stringContaining('From source')}});
  });
});
describe('preview choice limits (R9)', () => {
  const many = (count: number, size: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [choiceKey('page.tsx', `e${index}`), { kind: 'value' as const, value: 'x'.repeat(size) }]));
  it('accepts up to 2,000 choices and refuses 2,001', () => {
    expect(choicesProblem(many(2000, 1))).toBeNull();
    expect(choicesProblem(many(2001, 1))).toBe('At most 2000 preview choices are supported');
  });
  it('accepts up to 4 MB of choices and refuses more', () => {
    expect(choicesProblem(many(2000, 1900))).toBeNull();
    expect(choicesProblem(many(2000, 2100))).toBe('Preview choices exceed 4 MB');
  });
});
