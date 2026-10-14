import type { ComponentDef, DesignDoc, Page } from './types.js';

// Returns a fresh object on every call, so callers may mutate the result.
export function sampleDoc(): DesignDoc {
  const home: Page = {
    id: 'home',
    name: 'Home',
    route: '/',
    root: {
      id: 'n1', kind: 'element', tag: 'main', attrs: {}, style: { base: {} },
      children: [
        {
          id: 'n2', kind: 'element', name: 'Header', tag: 'header', attrs: {}, style: { base: {} },
          children: [
            {
              id: 'n3', kind: 'element', name: 'LoginButton', tag: 'button', attrs: {},
              style: { base: { padding: '8px' } },
              children: [{ id: 'n4', kind: 'text', text: 'Log in' }],
            },
          ],
        },
        {
          id: 'n5', kind: 'instance', name: 'Card', component: 'Card',
          props: { title: 'Hello' }, style: { base: {} },
        },
      ],
    },
  };

  const card: ComponentDef = {
    name: 'Card',
    props: { title: { default: 'Title' } },
    root: {
      id: 'n6', kind: 'element', tag: 'div', attrs: {}, style: { base: { padding: '16px' } },
      children: [
        {
          id: 'n7', kind: 'element', tag: 'h2', attrs: {}, style: { base: {} },
          children: [{ id: 'n8', kind: 'text', text: '{{title}}' }],
        },
      ],
    },
  };

  return {
    meta: { version: 1, seq: 9 },
    pages: { home },
    components: { Card: card },
    tokens: { color: { primary: '#3366ff' } },
  };
}
