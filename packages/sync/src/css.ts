import * as css from 'css-tree';
import type { Device, ElementNode, StyleMap, Tokens } from '@hub/design-model';
import { TOKEN_GROUP, TOKEN_NAME } from './tokens.js';
import { isSourceOnly, matchSelector, specificity, type SelectorAst, type TreeNode } from './selectors.js';

/** `file` is the stylesheet that declares the rule and `text` its unscoped selector, for diagnostics. */
export interface Rule { selector: SelectorAst; text: string; file: string; device: Device; layer: number; declarations: StyleMap; specificity: [number, number, number]; sourceOnly: boolean }
/** A dashed `:root` custom property `--group-name`, split at the first dash (Ruling D). */
export interface Token { group: string; name: string; value: string; layer: number; file: string }
/** `layers` collects first-appearance layer order across every stylesheet of one page. */
export interface StyleOptions { file: string; resolveImport(spec: string, from: string): { file: string; text: string }; layers?: string[] }
/** A CSS failure attributed to the stylesheet that contains it. */
export class CssError extends Error { constructor(readonly file: string, message: string) { super(message); } }

// R4: layer order beats specificity; unlayered rules (index 5) win.
const LAYERS = ['reset', 'theme', 'base', 'components', 'utilities'];
const SOURCE_ONLY_MEDIA = new Set(['hover:hover', 'hover:none', 'prefers-reduced-motion:reduce', 'min-width:1536px']);
const DEVICE_MEDIA: Record<string, Device> = { 'max-width:1023px': 'tablet', 'max-width:599px': 'mobile' };
// Animation definitions only matter while something animates, which the resting frame never shows (Ruling E).
const SOURCE_ONLY_AT_RULES = new Set(['keyframes', 'property']);

/** Resolves a media query list to a device or to a state the resting frame never shows (R2). */
function media(prelude: css.AtrulePrelude | css.Raw | null): Device | 'source' {
  const text = prelude ? css.generate(prelude) : '';
  const list = prelude?.type === 'AtrulePrelude' ? prelude.children.first : null;
  if (!list || list.type !== 'MediaQueryList') throw new Error(`Unsupported CSS at-rule @media ${text}`);
  const queries = list.children.toArray().map((query): Device | 'source' => {
    if (query.type !== 'MediaQuery' || query.modifier || (query.mediaType && query.mediaType !== 'print')) throw new Error(`Unsupported CSS at-rule @media ${text}`);
    let source = query.mediaType === 'print', device: Device | null = null;
    for (const part of query.condition?.children.toArray() ?? []) {
      if (part.type === 'Identifier' && part.name === 'and') continue;
      const key = part.type === 'Feature' && part.value ? `${part.name}:${css.generate(part.value)}`.replace(/\s/g, '') : '';
      if (SOURCE_ONLY_MEDIA.has(key)) source = true;
      else if (DEVICE_MEDIA[key] && !device) device = DEVICE_MEDIA[key];
      else throw new Error(`Unsupported CSS at-rule @media ${text}`);
    }
    if (source) return 'source';
    if (!device) throw new Error(`Unsupported CSS at-rule @media ${text}`);
    return device;
  });
  if (queries.every((query) => query === 'source')) return 'source';
  if (queries.length !== 1) throw new Error(`Unsupported CSS at-rule @media ${text}`);
  return queries[0]!;
}

/** A deliberately bounded CSS subset. Unsupported rules fail before any design is written. */
export function parseStyles(text: string, scope: string | null, opts: StyleOptions): { rules: Rule[]; tokens: Token[]; sourceOnly: number } {
  const rules: Rule[] = [];
  const tokens: Token[] = [];
  const layers = opts.layers ?? [];
  let sourceOnly = 0;
  interface Context { device: Device; layer: number; source: boolean; top: boolean }
  function read(nodes: css.List<css.CssNode>, at: Context, stack: string[]): void {
    nodes.forEach((node) => {
      if (node.type === 'Comment') return;
      if (node.type === 'Atrule') {
        const prelude = node.prelude ? css.generate(node.prelude) : '';
        if (node.name === 'import') {
          const target = node.prelude?.type === 'AtrulePrelude' && node.prelude.children.size === 1 ? node.prelude.children.first : null;
          const spec = target?.type === 'String' || target?.type === 'Url' ? target.value : null;
          if (spec === null || node.block || !at.top) throw new Error(`Unsupported CSS at-rule @import ${prelude}`);
          if (!spec.startsWith('.')) throw new Error(`Unsupported CSS package import ${spec}`);
          if (scope) throw new Error('Unsupported CSS @import in a CSS Module');
          const imported = opts.resolveImport(spec, stack[stack.length - 1]!);
          if (stack.includes(imported.file)) throw new Error(`Cyclic CSS @import ${spec}`);
          sheet(imported.text, imported.file, [...stack, imported.file]);
          return;
        }
        if (node.name === 'layer') {
          const list = node.prelude?.type === 'AtrulePrelude' && node.prelude.children.size === 1 ? node.prelude.children.first : null;
          const names = list?.type === 'LayerList' ? list.children.toArray().map((layer) => layer.type === 'Layer' ? layer.name : '') : [];
          for (const name of names) if (!LAYERS.includes(name)) throw new Error(`Unsupported CSS layer ${name || prelude}`);
          if (!names.length) throw new Error(`Unsupported CSS anonymous @layer ${prelude}`);
          if (node.block ? names.length !== 1 || at.layer !== LAYERS.length || at.device !== 'base' : !at.top) throw new Error(`Unsupported CSS nested @layer ${prelude}`);
          // Browsers order layers by first appearance; the importer requires that to be the canonical order (R4).
          for (const name of names) if (!layers.includes(name)) layers.push(name);
          if (layers.some((name, i) => i > 0 && LAYERS.indexOf(name) < LAYERS.indexOf(layers[i - 1]!))) throw new Error(`Unsupported CSS layer order: ${layers.join(', ')}`);
          if (!node.block) return;
          read(node.block.children, { ...at, layer: LAYERS.indexOf(names[0]!), top: false }, stack);
          return;
        }
        if (SOURCE_ONLY_AT_RULES.has(node.name) && node.block) { sourceOnly++; return; }
        if (node.name !== 'media' || !node.block) throw new Error(`Unsupported CSS at-rule @${node.name} ${prelude}`);
        const target = media(node.prelude);
        if (target === 'source') read(node.block.children, { ...at, source: true, top: false }, stack);
        else if (at.device === 'base' || at.source) read(node.block.children, { ...at, device: at.device === 'base' ? target : at.device, top: false }, stack);
        else throw new Error(`Unsupported CSS at-rule @media ${prelude} nested in a device query`);
        return;
      }
      if (node.type !== 'Rule' || node.prelude.type !== 'SelectorList') throw new Error('Unsupported CSS rule');
      const declarations: StyleMap = {};
      node.block.children.forEach((declaration) => {
        if (declaration.type !== 'Declaration' || declaration.important) throw new Error('Unsupported CSS declaration (including !important)');
        if (Object.hasOwn(declarations, declaration.property) || ['__proto__', 'constructor', 'prototype'].includes(declaration.property)) throw new Error('Unsupported CSS repeated or reserved property');
        declarations[declaration.property] = declaration.property.startsWith('--') ? css.generate(declaration.value).trim() : css.generate(declaration.value);
      });
      node.prelude.children.forEach((selector) => {
        if (selector.type !== 'Selector' || !selector.children.size) throw new Error(`Unsupported CSS selector ${css.generate(selector)}`);
        const source = isSourceOnly(selector, Object.hasOwn(declarations, 'content')) || at.source;
        const text = css.generate(selector);
        let own = declarations;
        if (text === ':root' && at.device === 'base' && !source) {
          own = {};
          for (const [property, value] of Object.entries(declarations)) {
            // Undashed custom properties such as shadcn's `--background` stay declarations on the root.
            const dash = property.startsWith('--') ? property.indexOf('-', 2) : -1;
            if (dash < 0) { own[property] = value; continue; }
            const group = property.slice(2, dash), name = property.slice(dash + 1);
            if (!TOKEN_GROUP.test(group) || !TOKEN_NAME.test(name)) throw new Error(`Unsupported CSS token name ${property}: a :root token must be --group-name in lowercase letters, digits, _ and -`);
            tokens.push({ group, name, value, layer: at.layer, file: stack[stack.length - 1]! });
          }
          if (!Object.keys(own).length) return;
        }
        if (scope) css.walk(selector, (part) => { if (part.type === 'ClassSelector') part.name = `${scope}__${part.name}`; });
        if (source) sourceOnly++;
        rules.push({ selector, text, file: stack[stack.length - 1]!, device: at.device, layer: at.layer, declarations: own, specificity: specificity(selector), sourceOnly: source });
      });
    });
  }
  function sheet(content: string, file: string, stack: string[]): void {
    try {
      const tree = css.parse(content, { parseValue: false, parseCustomProperty: false });
      const top = tree.type === 'StyleSheet' ? tree.children.toArray().filter((node) => node.type !== 'Comment') : [];
      const head = top.findIndex((node) => node.type !== 'Atrule' || node.name !== 'import' && (node.name !== 'layer' || !!node.block));
      if (head >= 0 && top.slice(head).some((node) => node.type === 'Atrule' && node.name === 'import')) throw new Error('Unsupported CSS @import after other rules');
      read(tree.type === 'StyleSheet' ? tree.children : new css.List(), { device: 'base', layer: LAYERS.length, source: false, top: true }, stack);
    } catch (error) { throw error instanceof CssError ? error : new CssError(file, error instanceof Error ? error.message : 'Invalid CSS'); }
  }
  sheet(text, opts.file, [opts.file]);
  return { rules, tokens, sourceOnly };
}

/** The token each `--group-name` resolves to over every stylesheet of a page, in load order: layer order, then source order. */
export function winningTokens(tokens: Token[]): Token[] {
  const winners = new Map<string, Token>();
  const ordered = tokens.map((token, order) => ({ token, order })).sort((a, b) => a.token.layer - b.token.layer || a.order - b.order);
  for (const { token } of ordered) winners.set(`--${token.group}-${token.name}`, token);
  return [...winners.values()];
}

export function cascadeTokens(tokens: Token[]): Tokens {
  const result: Tokens = {};
  for (const token of winningTokens(tokens)) (Object.hasOwn(result, token.group) ? result[token.group]! : (result[token.group] = {}))[token.name] = token.value;
  return result;
}

/**
 * Compiles source classes into style maps over the fully expanded source tree (R3). A `wrapper` root is a
 * synthetic page root that is not itself styled. `matched` receives the resting rules matching each element.
 */
export function applyStyles(root: ElementNode, rules: Rule[], inline: Map<string, StyleMap>, opts: { wrapper?: boolean; matched?: Map<ElementNode, Rule[]> } = {}): void {
  const known = new Set<string>();
  for (const rule of rules) css.walk(rule.selector, (part) => { if (part.type === 'ClassSelector') known.add(part.name); });
  const resting = rules.map((rule, order) => ({ rule, order })).filter(({ rule }) => !rule.sourceOnly);
  function visit(node: ElementNode, view: TreeNode, styled: boolean): void {
    for (const className of (node.attrs['class'] ?? '').split(/\s+/).filter(Boolean)) {
      if (!known.has(className)) throw new Error(`Unresolved CSS class ${className}; utility classes and Tailwind are unsupported`);
    }
    const elements = node.children.filter((child) => child.kind !== 'text');
    elements.forEach((child, index) => {
      if (child.kind === 'element') visit(child, { tag: child.tag, attrs: { ...child.attrs }, parent: view, index, siblings: elements.length }, true);
    });
    if (styled) {
      const matching = resting.filter(({ rule }) => {
        try { return matchSelector(view, rule.selector); }
        catch (error) { throw new CssError(rule.file, `${error instanceof Error ? error.message : 'Invalid selector'} in ${rule.text}`); }
      })
        .sort((a, b) => a.rule.layer - b.rule.layer || a.rule.specificity[0] - b.rule.specificity[0] || a.rule.specificity[1] - b.rule.specificity[1] || a.rule.specificity[2] - b.rule.specificity[2] || a.order - b.order);
      for (const device of ['base', 'tablet', 'mobile'] as const) {
        const style: StyleMap = {};
        // Keys are kept in the order they were last set, so the checks below see the cascade order.
        const set = (map: StyleMap | undefined) => { for (const [property, value] of Object.entries(map ?? {})) { delete style[property]; style[property] = value; } };
        for (const { rule } of matching) {
          if (rule.device === 'base' || rule.device === device || (device === 'mobile' && rule.device === 'tablet')) set(rule.declarations);
        }
        set(inline.get(node.id));
        // Canonical style maps sort properties, which puts a shorthand before its own longhands. A longhand set
        // before its shorthand (which resets it) cannot be retained; `all` resets everything and sorts anywhere.
        const order = Object.keys(style);
        for (const shorthand of ['all', 'margin', 'padding', 'border', 'background', 'font', 'flex', 'grid', 'animation', 'transition', 'outline', 'list-style', 'overflow', 'gap', 'inset']) {
          const at = order.indexOf(shorthand);
          if (at >= 0 && order.some((property, index) => property !== shorthand && (shorthand === 'all' || (index < at && property.startsWith(`${shorthand}-`))))) {
            throw new Error(`Unsupported CSS mixed shorthand and longhand: ${shorthand}`);
          }
        }
        if (device === 'base' || matching.some(({ rule }) => rule.device !== 'base')) node.style[device] = style;
      }
      opts.matched?.set(node, matching.map(({ rule }) => rule));
    }
    // The design model owns its generated class attribute; source classes are compiled into style maps.
    delete node.attrs['class'];
  }
  visit(root, { tag: root.tag, attrs: { ...root.attrs }, parent: null, index: 0, siblings: 1 }, !opts.wrapper);
}
