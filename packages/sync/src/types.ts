import type { DesignDoc, StyleMap } from '@hub/design-model';

/**
 * Paths are relative POSIX paths; callers read files without executing app code. `aliases` maps an import
 * prefix to a source-relative directory, for example `{ "@/": "site/src/" }`; the longest prefix wins.
 */
export interface SourceProject { files: Record<string, string>; aliases?: Record<string, string> }
export interface RouteEntry { route: string; file: string; exportName?: string; layouts?: string[] }
export interface SourceGap { key: string; file: string; expression: string; kind: 'value' | 'nodes' }
export interface SourceDiagnostic { file: string; message: string; gap?: SourceGap }
export interface PreviewNode { tag: string; attrs?: Record<string, string>; style?: StyleMap; children?: (PreviewNode | string)[] }
export type PreviewChoice = ({ kind: 'value'; value: string | number | boolean | null | Record<string, unknown> | unknown[] } | { kind: 'nodes'; nodes: (PreviewNode | string)[] }) & { source?: { file: string; expression: string } };
export type PreviewChoices = Record<string, PreviewChoice>;
export interface ExtractOptions { sharedComponents?: boolean; choices?: PreviewChoices }
export type ExtractResult =
  | { ok: true; doc: DesignDoc; dependencies: Record<string, string[]> }
  | { ok: false; diagnostics: SourceDiagnostic[] };
