import { expect, test } from 'vitest';
import { SERVER_MSG_TYPES, isOpenTask, parseClientMsg, parseServerMsg } from './index.js';

test('parses known server messages', () => {
  expect(parseServerMsg('{"type":"pong","t":5}')).toEqual({ type: 'pong', t: 5 });
});

test('rejects unknown or malformed data', () => {
  expect(parseServerMsg('nope')).toBeNull();
  expect(parseServerMsg('{"type":"x"}')).toBeNull();
  expect(parseServerMsg('[]')).toBeNull();
  expect(parseServerMsg('null')).toBeNull();
});

test('parseClientMsg accepts ping only', () => {
  expect(parseClientMsg('{"type":"ping","t":1}')).toEqual({ type: 'ping', t: 1 });
  expect(parseClientMsg('{"type":"ping"}')).toBeNull();
  expect(parseClientMsg('{"type":"pong","t":1}')).toBeNull();
});

test('lists every server message type', () => {
  expect(SERVER_MSG_TYPES).toEqual(['render.ready', 'build.message', 'build.task', 'design.message', 'design.status', 'pong']);
});

test('open task statuses', () => {
  expect(isOpenTask('review')).toBe(true);
  expect(isOpenTask('merged')).toBe(false);
  expect(isOpenTask('closed')).toBe(false);
});

test('parseClientMsg rejects a non-finite t', () => {
  // JSON.parse turns 1e999 into Infinity.
  expect(parseClientMsg('{"type":"ping","t":1e999}')).toBeNull();
  expect(parseClientMsg('{"type":"ping","t":-1e999}')).toBeNull();
  expect(parseClientMsg('{"type":"ping","t":"1"}')).toBeNull();
});

test('parseServerMsg checks the tag only', () => {
  // Documented behaviour: a known type with a wrong payload still parses.
  expect(parseServerMsg('{"type":"pong"}')).toEqual({ type: 'pong' });
});
