import { describe, expect, it } from 'vitest';
import type { DesignLayers, LayerNode } from '@hub/protocol';
import { alive, enter, enterPath, leave, modeLabel, rootOf } from './component-mode.js';

const n = (id: string, kind: LayerNode['kind'], children: LayerNode[] = [], component?: string): LayerNode => ({ id, name: id, kind, children, ...(component ? { component } : {}) });
const root = n('root', 'element', [
  n('a', 'instance', [n('a/r', 'element', [n('a/b', 'instance', [n('a/b/s', 'element')], 'Chip')])], 'Panel'),
]);
const layers: DesignLayers = { revision: 'r1', root, components: { Panel: { title: 'Filter Panel', uses: 3 }, Chip: { title: 'Chip', uses: 7 } } };

describe('component mode stack', () => {
  it('enters an instance at the page level, then one nested in it', () => {
    expect(enter([], 'a')).toEqual(['a']);
    expect(enter(['a'], 'a/b')).toEqual(['a', 'a/b']);
  });
  it('ignores an instance outside the current one', () => {
    expect(enter(['a'], 'c')).toEqual(['a']);
    expect(enter(['a'], 'a')).toEqual(['a']);
  });
  it('enters every instance on the way to a layer', () => {
    expect(enterPath('a/b/s')).toEqual(['a', 'a/b']);
    expect(enterPath('a/r')).toEqual(['a']);
    expect(enterPath('x')).toEqual([]);
  });
  it('leaves one level', () => {
    expect(leave(['a', 'a/b'])).toEqual(['a']);
    expect(leave([])).toEqual([]);
  });
  it('drops instances that left the outline', () => {
    expect(alive(['a', 'a/b'], root)).toEqual(['a', 'a/b']);
    expect(alive(['a', 'a/gone'], root)).toEqual(['a']);
    expect(alive(['gone', 'gone/x'], root)).toEqual([]);
  });
  it('labels the mode with the innermost component, its uses and the path', () => {
    expect(modeLabel([], layers)).toBeNull();
    expect(modeLabel(['a'], layers)).toEqual({ title: 'Filter Panel', uses: 3, path: 'Filter Panel', component: 'Panel' });
    expect(modeLabel(['a', 'a/b'], layers)).toEqual({ title: 'Chip', uses: 7, path: 'Filter Panel › Chip', component: 'Chip' });
  });
  it('finds the component root layer of an instance', () => {
    expect(rootOf(root, 'a')).toBe('a/r');
    expect(rootOf(root, 'nope')).toBeNull();
  });
});
