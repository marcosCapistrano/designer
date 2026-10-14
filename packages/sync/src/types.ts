import type { DesignDoc } from '@hub/design-model';

/** Paths are relative POSIX paths; callers read files without executing app code. */
export interface SourceProject { files: Record<string, string> }
export interface RouteEntry { route: string; file: string; exportName?: string; layouts?: string[] }
export interface SourceDiagnostic { file: string; message: string }
export interface ExtractOptions { sharedComponents?: boolean }
export type ExtractResult =
  | { ok: true; doc: DesignDoc; dependencies: Record<string, string[]> }
  | { ok: false; diagnostics: SourceDiagnostic[] };
