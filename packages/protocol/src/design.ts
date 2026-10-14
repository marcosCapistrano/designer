import type { RenderManifest } from './render.js';
export interface ImportRoute { route: string; file: string; exportName?: string; layouts?: string[] }
export type ImportRequest = { mode: 'next'; appDir?: string } | { mode: 'react'; entries: ImportRoute[] };
export interface ImportDiagnostic { file: string; message: string }
export type ImportResponse =
  | { ok: true; revision: string; rebuilt: string[]; reused: string[]; removed: string[]; manifest: RenderManifest | null; warnings: string[] }
  | { ok: false; kind: 'source'; diagnostics: ImportDiagnostic[] }
  | { ok: false; kind: 'replay'; conflicts: { index: number; op: unknown; message: string }[]; blocked: number[] };
export interface DesignSummary { imported: boolean; revision: string | null; pages: { id: string; route: string; name: string }[]; pending: number }
