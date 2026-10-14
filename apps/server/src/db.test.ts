import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate, openDb } from './db.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hub-db-'));
  tempDirs.push(dir);
  return dir;
}

function tableNames(db: Database.Database): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return rows.map((row) => row.name);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('openDb', () => {
  it('fresh db migrates to the latest version', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    const tables = tableNames(db);
    expect(tables).toEqual(expect.arrayContaining(['auth_sessions', 'build_chats', 'build_tasks', 'build_messages']));
    db.close();
  });

  it('file db uses WAL and creates its folder', () => {
    const file = join(makeTempDir(), 'sub', 'hub.sqlite');
    const db = openDb(file);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(existsSync(file)).toBe(true);
    db.close();
  });
});

describe('migrate', () => {
  it('migrate is idempotent', () => {
    const db = openDb(':memory:');
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(migrate(db)).toBe(MIGRATIONS.length);
    db.close();
  });

  it('applies only pending migrations', () => {
    const db = new Database(':memory:');
    expect(migrate(db, ['CREATE TABLE a(x)'])).toBe(1);
    expect(migrate(db, ['CREATE TABLE a(x)', 'CREATE TABLE b(y)'])).toBe(2);
    expect(tableNames(db)).toEqual(expect.arrayContaining(['a', 'b']));
    db.close();
  });

  it('a failing migration stops at the last good version', () => {
    const db = new Database(':memory:');
    expect(() => migrate(db, ['CREATE TABLE a(x)', 'CREATE TABLE a(x)'])).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    db.close();
  });
});
