import { describe, expect, test } from 'vitest';
import {
  DENIED_TAGS,
  RESERVED_KEYS,
  VOID_TAGS,
  validateAttrValue,
  validateNodeId,
  validatePageId,
  validateTag,
} from './rules.js';

describe('RESERVED_KEYS', () => {
  test('holds the three Object.prototype names that records cannot use', () => {
    expect(RESERVED_KEYS).toEqual(new Set(['__proto__', 'constructor', 'prototype']));
  });
});

describe('validateNodeId', () => {
  test.each(['n1', 'n999999999999999', 'Header', 'a.b:c_d-e'])('accepts %s', (id) => {
    expect(validateNodeId(id)).toBeNull();
  });

  test('accepts an id of 128 characters', () => {
    expect(validateNodeId(`a${'b'.repeat(127)}`)).toBeNull();
  });

  test.each(['', 'a b', 'x"y', 'n5/n6', 'n9007199254740993', '1a', '_a', 'n1000000000000000'])(
    'rejects %j',
    (id) => {
      expect(validateNodeId(id)).toBe(`Invalid node id "${id}"`);
    },
  );

  test('rejects an id of 129 characters', () => {
    expect(validateNodeId(`a${'b'.repeat(128)}`)).not.toBeNull();
  });

  test('truncates a long invalid id to 64 characters in the message', () => {
    expect(validateNodeId(`a${'b'.repeat(128)}`)).toBe(`Invalid node id "a${'b'.repeat(63)}"`);
  });

  test('names a non-string with String()', () => {
    expect(validateNodeId(5)).toBe('Invalid node id "5"');
    expect(validateNodeId(null)).toBe('Invalid node id "null"');
    expect(validateNodeId(undefined)).toBe('Invalid node id "undefined"');
  });
});

describe('validatePageId', () => {
  test.each(['home', 'pricing-2', '0-start', 'a'.repeat(64)])('accepts %s', (id) => {
    expect(validatePageId(id)).toBeNull();
  });

  test.each(['Home', 'a/b', 'pricing_page', 'pricing page', '', '-a', 'constructor', 'prototype', '__proto__'])(
    'rejects %j',
    (id) => {
      expect(validatePageId(id)).toBe(`Invalid page id "${id}"`);
    },
  );

  test('rejects an id of 65 characters', () => {
    const id = 'a'.repeat(65);
    expect(validatePageId(id)).toBe(`Invalid page id "${id}"`);
  });

  test('rejects a non-string', () => {
    expect(validatePageId(7)).toBe('Invalid page id "7"');
  });
});

describe('DENIED_TAGS and VOID_TAGS', () => {
  test('DENIED_TAGS lists the tags that can run script, load content or change the page frame', () => {
    expect(DENIED_TAGS).toEqual(new Set([
      'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'meta',
      'link', 'noscript', 'template', 'slot', 'portal', 'title', 'head', 'html', 'body',
    ]));
  });

  test('VOID_TAGS lists the tags that take no children', () => {
    expect(VOID_TAGS).toEqual(new Set([
      'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
    ]));
  });
});

describe('validateTag', () => {
  test.each(['div', 'my-widget', 'h2', 'img'])('accepts %s', (tag) => {
    expect(validateTag(tag)).toBeNull();
  });

  test('rejects a tag that fails the pattern, with the existing message', () => {
    expect(validateTag('Div')).toBe('Invalid tag "Div"');
  });

  test.each(['script', 'style', 'iframe', 'template', 'title', 'html', 'body'])('denies %s', (tag) => {
    expect(validateTag(tag)).toBe(`Tag "${tag}" is not allowed`);
  });
});

describe('validateAttrValue', () => {
  test('accepts an ordinary value', () => {
    expect(validateAttrValue('title', 'hello')).toBeNull();
  });

  test('rejects srcdoc whatever its value', () => {
    expect(validateAttrValue('srcdoc', '<p>x</p>')).toBe('Attribute srcdoc is not allowed');
  });

  test.each([
    'javascript:alert(1)',
    ' JaVa\tscript:x',
    'data:text/html,x',
    'vbscript:msgbox',
    '\n\u0000javascript:x',
    'java\u0000script:x',
  ])('rejects the unsafe URL %j in href', (value) => {
    expect(validateAttrValue('href', value)).toBe('Unsafe URL in attribute href');
  });

  test('reports a value that is not a string instead of throwing', () => {
    expect(validateAttrValue('href', 5 as unknown as string)).toBe('Attribute href must have a string value');
  });

  test('checks every attribute name, not only href', () => {
    expect(validateAttrValue('title', 'javascript:x')).toBe('Unsafe URL in attribute title');
  });

  test.each(['https://x', '/relative', 'mailto:a@b.c', 'data:image/png;base64,AAAA', 'data:text/plain,hi'])(
    'accepts %s',
    (value) => {
      expect(validateAttrValue('href', value)).toBeNull();
    },
  );
});
