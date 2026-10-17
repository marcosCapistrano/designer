import type { RenderManifest, NodeSelection } from './render.js';
export interface ImportRoute { route: string; file: string; exportName?: string; layouts?: string[] }
export type ImportRequest = { mode: 'next'; appDir?: string } | { mode: 'react'; entries: ImportRoute[] };
export interface ImportDiagnostic { file: string; message: string; gap?: { key: string; file: string; expression: string; kind: 'value' | 'nodes' } }
/** R7: a route whose extraction failed in an applied import; it kept its previous version or stayed absent. */
export interface ImportFailure { route: string; diagnostics: ImportDiagnostic[] }
/** Ruling F: a component expanded in place on a route instead of becoming a shared definition. */
export interface ImportInlined { route: string; component: string; file: string; reason: 'children' | 'optional-prop' | 'prop-css' }
/** `sourceOnlyRules` counts the CSS rules and blocks the resting-state frames do not show (R2), such as hover and print. */
export type ImportResponse =
  | { ok: true; revision: string; rebuilt: string[]; reused: string[]; removed: string[]; failed: ImportFailure[]; inlined: ImportInlined[]; sourceOnlyRules: number; manifest: RenderManifest | null; warnings: string[] }
  | { ok: false; kind: 'source'; diagnostics: ImportDiagnostic[] }
  | { ok: false; kind: 'replay'; conflicts: { index: number; op: unknown; message: string }[]; blocked: number[] };
export interface DesignSummary { imported: boolean; revision: string | null; pages: { id: string; route: string; name: string }[]; pending: number; sourceOnlyRules: number; inlined: ImportInlined[] }
export interface DesignTarget {
  id: string; kind: 'element' | 'text' | 'instance'; shared: boolean;
  tag?: string; text?: string; textNode?: string; component?: string;
  attrs?: Record<string, string>; style?: { base: Record<string, string>; tablet?: Record<string, string>; mobile?: Record<string, string> };
  props?: Record<string, string>;
  declaredProps?: Record<string, string>;
  /** Display name: the layer's own name, else its tag or component title. */
  name?: string;
  /** For an instance: its component's title. */
  title?: string;
}
export interface LayerNode { id: string; name: string; kind: 'element' | 'text' | 'instance'; component?: string; text?: string; children: LayerNode[] }
export interface DesignLayers { revision: string; root: LayerNode; components: Record<string, { title: string; uses: number }> }
export interface DesignSelection { revision: string; targets: DesignTarget[]; selection: NodeSelection }
export interface DesignProposal { id: string; revision: string; descriptions: string[]; manifest: RenderManifest | null; warnings: string[] }
export type DesignEditResult = { mode: 'applied'; revision: string; warnings: string[] } | { mode: 'preview'; proposal: DesignProposal };
export interface DesignMessage { id: number; app: string; kind: 'user' | 'assistant' | 'error'; text: string; at: number }
export interface DesignChatState { running: boolean; messages: DesignMessage[] }
export interface DesignChatResult { ok: boolean; text: string; edit: DesignEditResult | null; error?: string }
export interface SourcePreviewProposal { id: string; sourceCommit: string; samples: { file: string; expression: string; value: unknown }[]; manifest: RenderManifest | null; warnings: string[] }
export type SourcePreviewResult = { ok: true; proposal: SourcePreviewProposal } | Exclude<ImportResponse,{ok:true}>;
export interface SourcePreviewState { running: boolean; proposal: SourcePreviewProposal | null; acceptedSamples: number }
export interface SourcePreviewRequest { source: ImportRequest; text?: string }
