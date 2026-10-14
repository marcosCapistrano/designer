import type { RenderManifest, NodeSelection } from './render.js';
export interface ImportRoute { route: string; file: string; exportName?: string; layouts?: string[] }
export type ImportRequest = { mode: 'next'; appDir?: string } | { mode: 'react'; entries: ImportRoute[] };
export interface ImportDiagnostic { file: string; message: string }
export type ImportResponse =
  | { ok: true; revision: string; rebuilt: string[]; reused: string[]; removed: string[]; manifest: RenderManifest | null; warnings: string[] }
  | { ok: false; kind: 'source'; diagnostics: ImportDiagnostic[] }
  | { ok: false; kind: 'replay'; conflicts: { index: number; op: unknown; message: string }[]; blocked: number[] };
export interface DesignSummary { imported: boolean; revision: string | null; pages: { id: string; route: string; name: string }[]; pending: number }
export interface DesignTarget {
  id: string; kind: 'element' | 'text' | 'instance'; shared: boolean;
  tag?: string; text?: string; textNode?: string; component?: string;
  attrs?: Record<string, string>; style?: { base: Record<string, string>; tablet?: Record<string, string>; mobile?: Record<string, string> };
  props?: Record<string, string>;
  declaredProps?: Record<string, string>;
}
export interface DesignSelection { revision: string; targets: DesignTarget[]; selection: NodeSelection }
export interface DesignProposal { id: string; revision: string; descriptions: string[]; manifest: RenderManifest | null; warnings: string[] }
export type DesignEditResult = { mode: 'applied'; revision: string; warnings: string[] } | { mode: 'preview'; proposal: DesignProposal };
