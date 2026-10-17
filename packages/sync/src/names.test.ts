import { describe, expect, it } from 'vitest';
import type { DesignDoc, ElementNode, InstanceNode } from '@hub/design-model';
import { extractPages } from './index.js';

function extract(files: Record<string, string>, shared = false): DesignDoc {
  const result = extractPages({ files }, [{ route: '/', file: 'page.tsx' }], { sharedComponents: shared });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.doc;
}
const root = (doc: DesignDoc): ElementNode => Object.values(doc.pages)[0]!.root;
const child = (node: ElementNode, i: number) => node.children[i] as ElementNode;

describe('layer names at import', () => {
  it('data-name on an element becomes its name, not an attribute', () => {
    const doc = extract({ 'page.tsx': `export default () => <main data-name="Ads List"><h1 data-name="Title">Hi</h1></main>` });
    expect(root(doc).name).toBe('Ads List');
    expect(root(doc).attrs['data-name']).toBeUndefined();
    expect(child(root(doc), 0).name).toBe('Title');
  });

  it('empty data-name falls back', () => {
    const doc = extract({ 'page.tsx': `export default () => <main data-name="  "><h1>Hi</h1></main>` });
    expect(root(doc).name).toBeUndefined();
    expect(root(doc).attrs['data-name']).toBeUndefined();
  });

  it('a CSS module class names an unnamed element', () => {
    const doc = extract({
      'page.tsx': `import styles from './page.module.css'; export default () => <main className={styles.favoriteName}><p className={styles.bar_fill}>x</p><p data-name="Kept" className={styles.other}>y</p></main>`,
      'page.module.css': `.favoriteName { color: red; } .bar_fill { color: blue; } .other { color: green; }`,
    });
    expect(root(doc).name).toBe('Favorite Name');
    expect(child(root(doc), 0).name).toBe('Bar Fill');
    expect(child(root(doc), 1).name).toBe('Kept');
  });

  it('data-name on a shared component call names the instance and is not a prop', () => {
    const doc = extract({
      'page.tsx': `import Chip from './Chip'; export default () => <main><Chip data-name="Filtro" label="A" /></main>`,
      'Chip.tsx': `export default function Chip({ label }: { label: string }) { return <span>{label}</span>; }`,
    }, true);
    const instance = root(doc).children[0] as InstanceNode;
    expect(instance.kind).toBe('instance');
    expect(instance.name).toBe('Filtro');
    expect(instance.props).toEqual({ label: 'A' });
    expect(doc.components[instance.component]!.props).toEqual({ label: { default: '' } });
  });

  it('a shared definition root is named after its export', () => {
    const doc = extract({
      'page.tsx': `import { FilterChip } from './Chip'; export default () => <main><FilterChip label="A" /></main>`,
      'Chip.tsx': `export function FilterChip({ label }: { label: string }) { return <span>{label}</span>; }`,
    }, true);
    expect(Object.values(doc.components)[0]!.root.name).toBe('FilterChip');
  });

  it('data-name on an inlined component names its root', () => {
    const doc = extract({
      'page.tsx': `import Card from './Card'; export default () => <main><Card data-name="Ad Card"><b>x</b></Card></main>`,
      'Card.tsx': `export default function Card({ children }: { children: unknown }) { return <article>{children}</article>; }`,
    }, true);
    expect(child(root(doc), 0).name).toBe('Ad Card');
  });
});
