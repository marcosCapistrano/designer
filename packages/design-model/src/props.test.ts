import { describe, expect, test } from 'vitest';
import { resolveProps, substituteProps } from './props.js';
import type { ComponentDef, InstanceNode } from './types.js';

const card: ComponentDef = {
  name: 'Card',
  props: { title: { default: 'Title' }, tone: { default: 'plain' } },
  root: { id: 'n6', kind: 'element', tag: 'div', attrs: {}, style: { base: {} }, children: [] },
};

function instance(props: Record<string, string>): InstanceNode {
  return { id: 'n5', kind: 'instance', component: 'Card', props, style: { base: {} } };
}

describe('substituteProps', () => {
  test('replaces known placeholders', () => {
    expect(substituteProps('Hi {{name}}!', { name: 'Ann' })).toBe('Hi Ann!');
  });

  test('leaves unknown placeholders literal', () => {
    expect(substituteProps('{{nope}} {{name}}', { name: 'Ann' })).toBe('{{nope}} Ann');
  });

  test('only matches identifier names', () => {
    expect(substituteProps('{{a-b}} {{1a}} {{ name }}', { name: 'x' })).toBe(
      '{{a-b}} {{1a}} {{ name }}',
    );
  });

  test('looks up own keys only', () => {
    expect(substituteProps('{{constructor}}', {})).toBe('{{constructor}}');
  });

  test('substitutes in one pass, never inside a substituted value', () => {
    expect(substituteProps('{{a}}', { a: '{{b}}', b: 'x' })).toBe('{{b}}');
  });

  test('inserts values literally, with no replacement patterns', () => {
    expect(substituteProps('{{a}}', { a: '$&$1' })).toBe('$&$1');
  });
});

describe('resolveProps', () => {
  test('uses each declared default when the instance sets nothing', () => {
    expect(resolveProps(card, instance({}))).toEqual({ title: 'Title', tone: 'plain' });
  });

  test('instance props overlay the defaults', () => {
    expect(resolveProps(card, instance({ title: 'Hello' }))).toEqual({
      title: 'Hello',
      tone: 'plain',
    });
  });

  test('an empty string from the instance still overrides the default', () => {
    expect(resolveProps(card, instance({ title: '' })).title).toBe('');
  });

  test('ignores instance props the component does not declare', () => {
    expect(resolveProps(card, instance({ extra: 'x' }))).toEqual({
      title: 'Title',
      tone: 'plain',
    });
  });
});
