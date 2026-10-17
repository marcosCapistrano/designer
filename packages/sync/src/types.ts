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
export type InlineReason = 'children' | 'optional-prop' | 'prop-css';
/** One per route per inlined component, never per occurrence. */
export interface InlinedComponent { route: string; component: string; file: string; reason: InlineReason }
/** A route whose extraction failed in an otherwise applied import (R7): it keeps its previous version, or stays absent. */
export interface RouteFailure { route: string; diagnostics: SourceDiagnostic[] }
/**
 * A route's component keys (`<file>:<export>`): every one it rendered, those it inlined only because they arrived in
 * `ExtractOptions.inline`, every one it inlined, and the strongest reason the route itself gives for each.
 * Incremental sync merges `reasons` over routes, so the reported reason never depends on route or cache order.
 */
export interface RouteInlining { encountered: string[]; input: string[]; inline: { key: string; component: string; file: string }[]; reasons: Record<string, InlineReason> }
/** `inline` forces components, by key, to be inlined from the start; extraction adds every one it finds a reason for. */
export interface ExtractOptions { sharedComponents?: boolean; choices?: PreviewChoices; inline?: Record<string, InlineReason> }
/** Per shared component, per definition node id: the rules (`<selector> (<file>)`) that styled it on this route. */
export type ComponentRules = Record<string, Record<string, string[]>>;
/**
 * Per page id: `sourceOnly` counts, per stylesheet the route loaded, the rules and blocks parseStyles skipped as
 * source-only (R2), omitting stylesheets with none; `componentRules` lets cross-route definition mismatches name their selectors.
 */
export type ExtractResult =
  | { ok: true; doc: DesignDoc; dependencies: Record<string, string[]>; tokens: Record<string, TokenSource[]>; inlined: InlinedComponent[]; inlining: Record<string, RouteInlining>; sourceOnly: Record<string, Record<string, number>>; componentRules: Record<string, ComponentRules> }
  | { ok: false; diagnostics: SourceDiagnostic[] };
