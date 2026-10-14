import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { choicesProblem, synchronizePages, type PreviewChoice, type PreviewChoices, type SourceGap } from '@hub/sync';
import type { ImportRequest, ImportResponse, SourcePreviewProposal, SourcePreviewResult, SourcePreviewState } from '@hub/protocol';
import type { BuildService } from '../build/service.js';
import { BuildError } from '../build/ci.js';
import type { ClaudeRunner } from '../claude/runner.js';
import type { SyncService } from './service.js';

export interface PreviewActions { source(file: string): Promise<string>; choose(key: string, choice: unknown): Promise<unknown>; gaps(): Promise<SourceGap[]> }
export type PreviewMcpFactory = (actions: PreviewActions) => unknown;
const reply = async (run: () => Promise<unknown>) => { try { return { content: [{ type: 'text' as const, text: JSON.stringify(await run()) }] }; } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Invalid sample' }] }; } };
export const previewMcp: PreviewMcpFactory = (actions) => createSdkMcpServer({ name: 'preview', version:'1.0.0', tools: [
  tool('preview_get_source','Read a tracked source excerpt to choose representative preview data. Never execute it.',{file:z.string()},({file}) => reply(() => actions.source(file))),
  tool('preview_save_choice','Choose a JSON value or literal sample nodes for one reported dynamic source gap.',{key:z.string().regex(/^[a-f0-9]{64}$/),choice:z.unknown()},({key,choice}) => reply(() => actions.choose(key,choice))),
] });
interface Pending { app: string; request: ImportRequest; revision: string | null; choices: PreviewChoices; public: SourcePreviewProposal; expires: number }
export class SourcePreview {
  private readonly pending = new Map<string,Pending>();
  private readonly runs = new Map<string,AbortController>();
  private readonly ended = new Set<Promise<unknown>>();
  private closing = false;
  constructor(private readonly sync: Pick<SyncService,'load'|'save'|'source'|'preview'>, private readonly build: Pick<BuildService,'withCheckout'>, private readonly runner: ClaudeRunner, private readonly dataDir: string, private readonly mcp: PreviewMcpFactory = previewMcp, private readonly now = Date.now) {}
  async state(app: string): Promise<SourcePreviewState> {
    const saved = await this.sync.load(app);
    const proposal = [...this.pending.values()].find((item) => item.app === app && item.expires > this.now());
    return { running:this.runs.has(app),proposal:proposal?.public ?? null,acceptedSamples:Object.keys(saved?.state.choices ?? {}).length };
  }
  stop(app: string): boolean { const run = this.runs.get(app); run?.abort(); return !!run; }
  async close(): Promise<void> { this.closing = true; for (const run of this.runs.values()) run.abort(); await Promise.allSettled([...this.ended]); }
  propose(app: string, request: ImportRequest, instructions = ''): Promise<SourcePreviewResult> {
    if (this.closing) throw new BuildError('The Hub is shutting down.',409);
    if(instructions.length>4000)throw new BuildError('Preview preferences must be at most 4,000 characters.',400);
    const run = this.build.withCheckout(app, () => this.prepare(app,request,instructions));
    this.ended.add(run); void run.finally(() => this.ended.delete(run)).catch(() => {}); return run;
  }
  private async prepare(app: string, request: ImportRequest, instructions: string): Promise<SourcePreviewResult> {
    const controller = new AbortController(); this.runs.set(app,controller);
    try {
      const previous = await this.sync.load(app);
      const source = await this.sync.source(app,request);
      let choices: PreviewChoices = {};
      let prepared = synchronizePages({...source,previous:previous?.state,choices});
      let failures = 0, session: string | undefined;
      for (let pass=0;pass<20 && !prepared.ok;pass++) {
        if (prepared.kind !== 'source' || prepared.diagnostics.some((diagnostic) => !diagnostic.gap)) return prepared;
        const gaps = new Map<string,SourceGap>();
        for (const diagnostic of prepared.diagnostics) if (diagnostic.gap) gaps.set(diagnostic.gap.key,diagnostic.gap);
        if ([...gaps.values()].some((gap) => gap.expression.length>20_000) || JSON.stringify([...gaps.values()]).length>100_000) return {ok:false,kind:'source',diagnostics:[{file:'',message:'The dynamic source region is too large for one preview request. Extract smaller source components first.'}]};
        const actions: PreviewActions = {
          gaps: async()=>[...gaps.values()],
          source: async (file) => { if (!Object.hasOwn(source.project.files,file)) throw new Error('Only tracked source files from this import may be read.'); return source.project.files[file]!.slice(0,25_000); },
          choose: async (key,value) => {
            if (controller.signal.aborted) throw new Error('Stopped by you.');
            if (failures >= 2) throw new Error('Two invalid sample attempts failed. Explain the problem to the user.');
            try {
              const gap = gaps.get(key); if (!gap) throw new Error('Unknown source gap');
              const problem = choicesProblem({[key]:value}); if (problem) throw new Error(problem);
              const chosen = value as PreviewChoice;
              if (chosen.kind !== gap.kind) throw new Error(`This gap requires a ${gap.kind} choice`);
              const next = {...choices,[key]:{...chosen,source:{file:gap.file,expression:gap.expression}}};
              const checked = synchronizePages({...source,previous:previous?.state,choices:next});
              if (!checked.ok && checked.kind === 'source' && checked.diagnostics.some((diagnostic) => !diagnostic.gap)) throw new Error(checked.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
              choices = next; return { saved:true };
            } catch (error) { failures++; throw error; }
          },
        };
        const cwd = join(this.dataDir,'source-previews',app); await mkdir(cwd,{recursive:true,mode:0o700});
        let ok = false, error: string | undefined;
        for await (const event of this.runner.run({cwd,restrictTools:true,allowedTools:['mcp__preview__preview_get_source','mcp__preview__preview_save_choice'],mcpServers:{preview:this.mcp(actions)},signal:controller.signal,...(session?{resume:session}:{}),
          prompt:`${instructions?`User preview preferences: ${instructions}\n`:''}Choose representative preview-only sample data for these dynamic source gaps.\n${JSON.stringify([...gaps.values()])}`,
          systemPrompt:'Use only preview_get_source and preview_save_choice. Never execute app code, read arbitrary files or use other tools. Inspect the source and preserve its intended static markup. For a value gap choose {kind:"value",value:JSON data}; React useState choices contain the state value itself, not the [state,setter] tuple. React useEffect/useLayoutEffect choices must be null, acknowledging that effects are not executed. For a nodes gap choose {kind:"nodes",nodes:[literal text or {tag,attrs:string map,style:CSS string map,children:same node/text array}]}. Do not supply model IDs or reinterpret utility classes. Choices are samples, not real fetched data, and will be shown for user approval before import. Do not claim they are applied. After two invalid attempts ask the user.'})) {
          if (event.type === 'done') { ok = event.ok; error = event.error; session = event.sessionId || undefined; }
        }
        if (!ok || controller.signal.aborted) return {ok:false,kind:'source',diagnostics:[{file:'',message:controller.signal.aborted?'Preview generation stopped.':error ?? 'Claude Code could not choose preview samples.'}]};
        const before = prepared;
        prepared = synchronizePages({...source,previous:previous?.state,choices});
        if (!prepared.ok && JSON.stringify(prepared) === JSON.stringify(before)) return {ok:false,kind:'source',diagnostics:[{file:'',message:'No usable preview choice was supplied. Review the source or try a more specific sample.'}]};
      }
      if (!prepared.ok) return prepared;
      if (controller.signal.aborted) return {ok:false,kind:'source',diagnostics:[{file:'',message:'Preview generation stopped.'}]};
      const preview = await this.sync.preview(app,prepared.state.doc,false);
      if (controller.signal.aborted) return {ok:false,kind:'source',diagnostics:[{file:'',message:'Preview generation stopped.'}]};
      const id = randomUUID();
      const proposal: SourcePreviewProposal = { id,sourceCommit:source.commit,samples:Object.values(choices).map((choice) => ({file:choice.source?.file ?? '',expression:choice.source?.expression ?? '',value:choice.kind==='value'?choice.value:choice.nodes})),...preview };
      for (const [key,item] of this.pending) if (item.app===app || item.expires<=this.now()) this.pending.delete(key);
      this.pending.set(id,{app,request:structuredClone(request),revision:previous?.revision ?? null,choices,public:proposal,expires:this.now()+30*60_000});
      return {ok:true,proposal};
    } finally { this.runs.delete(app); }
  }
  async apply(app: string,id: string): Promise<ImportResponse> {
    return this.build.withCheckout(app,async () => {
      const item = this.pending.get(id);
      if (!item || item.app!==app || item.expires<=this.now()) throw new BuildError('Sample preview expired. Generate it again.',409);
      const previous = await this.sync.load(app);
      if ((previous?.revision ?? null)!==item.revision) throw new BuildError('Design changed. Generate the sample preview again.',409);
      const source = await this.sync.source(app,item.request);
      if (source.commit!==item.public.sourceCommit) throw new BuildError('Source changed. Generate the sample preview again.',409);
      const prepared = synchronizePages({...source,previous:previous?.state,choices:item.choices});
      if (!prepared.ok) return prepared;
      const revision = await this.sync.save(app,prepared.state,item.revision);
      const preview = await this.sync.preview(app,prepared.state.doc);
      this.pending.delete(id);
      return {ok:true,revision,rebuilt:prepared.rebuilt,reused:prepared.reused,removed:prepared.removed,...preview};
    });
  }
  cancel(app: string,id: string): void { if (this.pending.get(id)?.app===app) this.pending.delete(id); }
}
