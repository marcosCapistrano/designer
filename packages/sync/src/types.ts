import type { DesignDoc, StyleMap } from '@hub/design-model';
import type { Adapters } from '@hub/protocol/adapters';

/**
 * Paths are relative POSIX paths; callers read files without executing app code. `aliases` maps an import
 * prefix to a source-relative directory, for example `{ "@/": "site/src/" }`; the longest prefix wins. `adapters` is the
 * already-parsed `.hub/adapters.json`: external module exports rendered as data, and stylesheets to skip.
 */
export interface SourceProject { files: Record<string, string>; aliases?: Record<string, string>; adapters?: Adapters }
export interface RouteEntry { route: string; file: string; exportName?: string; layouts?: string[] }
export interface SourceGap { key: string; file: string; expression: string; kind: 'value' | 'nodes' }
export interface SourceDiagnostic { file: string; message: string; gap?: SourceGap }
export interface PreviewNode { tag: string; attrs?: Record<string, string>; style?: StyleMap; children?: (PreviewNode | string)[] }
export type PreviewChoice = ({ kind: 'value'; value: string | number | boolean | null | Record<string, unknown> | unknown[] } | { kind: 'nodes'; nodes: (PreviewNode | string)[] }) & { source?: { file: string; expression: string } };
export type PreviewChoices = Record<string, PreviewChoice>;
/** A resolved `:root` token `--group-name` and the stylesheet whose declaration won the cascade. */
export interface TokenSource { group: string; name: string; value: string; file: string }
/** Ruling F: why a source component is expanded in place instead of becoming a shared definition. */
export type InlineReason = 'children' | 'prop-css';
/** One per route per inlined component, never per occurrence. */
export interface InlinedComponent { route: string; component: string; file: string; reason: InlineReason }
/**
 * A route's component keys (`<file>:<export>`): every one it rendered, those that arrived already inlined in
 * `ExtractOptions.inline`, and every one it inlined. Incremental sync uses it to keep inlining consistent across routes.
 */
export interface RouteInlining { encountered: string[]; input: string[]; inline: { key: string; component: string; file: string; reason: InlineReason }[] }
/** `inline` forces components, by key, to be inlined from the start; extraction adds every one it finds a reason for. */
export interface ExtractOptions { sharedComponents?: boolean; choices?: PreviewChoices; inline?: Record<string, InlineReason> }
export type ExtractResult =
  | { ok: true; doc: DesignDoc; dependencies: Record<string, string[]>; tokens: Record<string, TokenSource[]>; inlined: InlinedComponent[]; inlining: Record<string, RouteInlining> }
  | { ok: false; diagnostics: SourceDiagnostic[] };
