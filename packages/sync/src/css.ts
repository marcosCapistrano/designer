import * as css from 'css-tree';
import type { Device, ElementNode, StyleMap } from '@hub/design-model';

interface Rule { selector: string; device: Device; declarations: StyleMap; specificity: [number, number, number] }

/** A deliberately bounded CSS subset. Unsupported rules fail before any design is written. */
export function parseStyles(text: string, scope: string | null): Rule[] {
  const tree = css.parse(text, { parseValue: false });
  const rules: Rule[] = [];
  function read(nodes: css.List<css.CssNode>, device: Device): void {
    nodes.forEach((node) => {
      if (node.type === 'Comment') return;
      if (node.type === 'Atrule') {
        const media = node.prelude ? css.generate(node.prelude).replace(/\s/g, '') : '';
        const next = media === '(max-width:1023px)' ? 'tablet' : media === '(max-width:599px)' ? 'mobile' : null;
        if (node.name !== 'media' || !next || !node.block || device !== 'base') {
          throw new Error(`Unsupported CSS at-rule @${node.name} ${media}`);
        }
        read(node.block.children, next);
        return;
      }
      if (node.type !== 'Rule' || node.prelude.type !== 'SelectorList') throw new Error('Unsupported CSS rule');
      const declarations: StyleMap = {};
      node.block.children.forEach((declaration) => {
        if (declaration.type !== 'Declaration' || declaration.important) throw new Error('Unsupported CSS declaration (including !important)');
        if (Object.hasOwn(declarations, declaration.property) || ['__proto__', 'constructor', 'prototype'].includes(declaration.property)) throw new Error('Unsupported CSS repeated or reserved property');
        declarations[declaration.property] = css.generate(declaration.value);
      });
      node.prelude.children.forEach((selector) => {
        const raw = css.generate(selector);
        if (!/^(?:\*|[a-z][a-z0-9-]*)?(?:[.#][a-zA-Z_][\w-]*)*$/.test(raw) || !raw) {
          throw new Error(`Unsupported CSS selector ${raw}`);
        }
        const scoped = scope ? raw.replace(/\.([\w-]+)/g, `.${scope}__$1`) : raw;
        rules.push({ selector: scoped, device, declarations, specificity: [raw.match(/#/g)?.length ?? 0, raw.match(/\./g)?.length ?? 0, /^[a-z]/.test(raw) ? 1 : 0] });
      });
    });
  }
  read(tree.type === 'StyleSheet' ? tree.children : new css.List(), 'base');
  return rules;
}

function matches(node: ElementNode, selector: string): boolean {
  const tag = selector.match(/^[a-z][a-z0-9-]*/)?.[0];
  if (tag && node.tag !== tag) return false;
  const classes = new Set((node.attrs['class'] ?? '').split(/\s+/));
  for (const part of selector.matchAll(/([.#])([\w-]+)/g)) {
    if (part[1] === '.' ? !classes.has(part[2]!) : node.attrs['id'] !== part[2]) return false;
  }
  return true;
}

export function applyStyles(root: ElementNode, rules: Rule[], inline: Map<string, StyleMap>): void {
  function visit(node: ElementNode): void {
    for (const className of (node.attrs['class'] ?? '').split(/\s+/).filter(Boolean)) {
      if (!rules.some((rule) => [...rule.selector.matchAll(/\.([\w-]+)/g)].some((match) => match[1] === className))) {
        throw new Error(`Unresolved CSS class ${className}; utility classes and Tailwind are unsupported`);
      }
    }
    const matching = rules.map((rule, order) => ({ rule, order })).filter(({ rule }) => matches(node, rule.selector))
      .sort((a, b) => a.rule.specificity[0] - b.rule.specificity[0] || a.rule.specificity[1] - b.rule.specificity[1] || a.rule.specificity[2] - b.rule.specificity[2] || a.order - b.order);
    for (const device of ['base', 'tablet', 'mobile'] as const) {
      const style: StyleMap = {};
      for (const { rule } of matching) {
        if (rule.device === 'base' || rule.device === device || (device === 'mobile' && rule.device === 'tablet')) Object.assign(style, rule.declarations);
      }
      Object.assign(style, inline.get(node.id));
      // Canonical style maps sort properties. Mixed shorthand/longhand order cannot be retained.
      for (const shorthand of ['all', 'margin', 'padding', 'border', 'background', 'font', 'flex', 'grid', 'animation', 'transition', 'outline', 'list-style', 'overflow', 'gap', 'inset']) {
        if (Object.hasOwn(style, shorthand) && Object.keys(style).some((property) => property !== shorthand && (shorthand === 'all' || property.startsWith(`${shorthand}-`)))) {
          throw new Error(`Unsupported CSS mixed shorthand and longhand: ${shorthand}`);
        }
      }
      if (device === 'base' || matching.some(({ rule }) => rule.device !== 'base')) node.style[device] = style;
    }
    for (const child of node.children) if (child.kind === 'element') visit(child);
    // The design model owns its generated class attribute; source classes are compiled into style maps.
    delete node.attrs['class'];
  }
  visit(root);
}
