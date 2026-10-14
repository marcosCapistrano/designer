import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe,expect,it } from 'vitest';
import { FsSyncStore } from '@hub/sync';
import { FakeClaudeRunner,type FakeStep } from '../claude/fake.js';
import { SyncService } from './service.js';
import { SourcePreview,type PreviewActions } from './preview.js';
async function setup(code='const user=loadUser();export default () => <main><h1>{user.name}</h1></main>'){
  const dir=await mkdtemp(join(tmpdir(),'hub-source-preview-'));
  const store=new FsSyncStore(dir);
  const source={project:{files:{'app/page.tsx':code}},commit:'one'};
  const build={withCheckout:async<T>(_app:string,action:()=>Promise<T>)=>action()};
  const sync=new SyncService({dataDir:dir,build,registry:{get:async name=>name==='demo'?{name,dir,adopted:false,manifest:null,manifestError:null}:null},hub:{broadcast:()=>{}},store:()=>store,readSource:async()=>source,render:async()=>({manifest:{version:1,pages:[]},warnings:[]})});
  let actions!:PreviewActions;
  const scripts:FakeStep[][]=[];const runner=new FakeClaudeRunner(scripts);
  const preview=new SourcePreview(sync,build,runner,dir,callbacks=>{actions=callbacks;return{fake:true}});
  return{preview,sync,store,source,runner,scripts,actions:()=>actions};
}
describe('reviewed subscription source samples',()=>{
  it('generates representative data without publishing, then stores choices for deterministic imports',async()=>{
    const s=await setup();
    s.scripts.push([async()=>{const gap=(await s.actions().gaps())[0]!;expect(await s.actions().source(gap.file)).toContain('loadUser');await s.actions().choose(gap.key,{kind:'value',value:{name:'Preview Alice'}})},{type:'done',ok:true,sessionId:'samples'}]);
    const result=await s.preview.propose('demo',{mode:'next'},'Show Alice');
    expect(result.ok).toBe(true);expect(await s.store.load()).toBeNull();
    expect(s.runner.calls[0]).toMatchObject({restrictTools:true,allowedTools:['mcp__preview__preview_get_source','mcp__preview__preview_save_choice']});
    expect(s.runner.calls[0]!.prompt).toContain('Show Alice');
    if(!result.ok)return;
    expect(result.proposal.samples[0]).toMatchObject({expression:'loadUser()',value:{name:'Preview Alice'}});
    expect(await s.preview.apply('demo',result.proposal.id)).toMatchObject({ok:true,rebuilt:['/']});
    expect((await s.store.load())!.state.choices).toBeDefined();
    expect(await s.sync.import('demo',{mode:'next'})).toMatchObject({ok:true,reused:['/'],rebuilt:[]});
    await expect(s.preview.apply('demo',result.proposal.id)).rejects.toMatchObject({status:409});
    await s.preview.close();await s.sync.close();
  });
  it('refuses source changes between preview and Apply and never overwrites existing state',async()=>{
    const s=await setup();
    s.scripts.push([async()=>{const gap=(await s.actions().gaps())[0]!;await s.actions().choose(gap.key,{kind:'value',value:{name:'Alice'}})},{type:'done',ok:true,sessionId:'s'}]);
    const result=await s.preview.propose('demo',{mode:'next'});if(!result.ok)throw new Error(JSON.stringify(result));
    s.source.commit='two';
    await expect(s.preview.apply('demo',result.proposal.id)).rejects.toMatchObject({status:409});
    expect(await s.store.load()).toBeNull();
    await s.preview.close();await s.sync.close();
  });
  it('does not call Claude for unsupported static source and rejects invalid sample output',async()=>{
    const s=await setup('export default () => <script>bad</script>');
    expect(await s.preview.propose('demo',{mode:'next'})).toMatchObject({ok:false,kind:'source'});expect(s.runner.calls).toHaveLength(0);
    s.source.project.files['app/page.tsx']='export default () => <main>{dynamic()}</main>';
    s.scripts.push([async()=>{const gap=(await s.actions().gaps())[0]!;await expect(s.actions().choose(gap.key,{kind:'nodes',nodes:[{tag:'script'}]})).rejects.toThrow();await expect(s.actions().choose('0'.repeat(64),{kind:'nodes',nodes:[]})).rejects.toThrow('Unknown');await expect(s.actions().choose(gap.key,{kind:'nodes',nodes:['Sample']})).rejects.toThrow('Two invalid')},{type:'done',ok:true,sessionId:'invalid'}]);
    expect(await s.preview.propose('demo',{mode:'next'})).toMatchObject({ok:false,kind:'source'});expect(await s.store.load()).toBeNull();
    await s.preview.close();await s.sync.close();
  });
});
