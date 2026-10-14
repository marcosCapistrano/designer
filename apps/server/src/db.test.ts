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

  it('enforces foreign keys and waits for a busy database', () => {
    const db = openDb(':memory:');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(() =>
      db
        .prepare("INSERT INTO build_messages (app, task_id, kind, text, created_at) VALUES ('a', 999, 'status', 't', 1)")
        .run(),
    ).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it('refuses a database written by a newer hub and closes it', () => {
    const file = join(makeTempDir(), 'hub.sqlite');
    const newer = new Database(file);
    newer.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    newer.close();
    expect(() => openDb(file)).toThrow(/schema version \d+/);
    // The refusal changed nothing.
    const check = new Database(file);
    expect(check.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length + 1);
    check.close();
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

  it('rejects a version newer than the migrations it knows', () => {
    const db = new Database(':memory:');
    db.pragma('user_version = 3');
    expect(() => migrate(db, ['CREATE TABLE a(x)'])).toThrow(/version 3.*up to 1/);
    expect(tableNames(db)).not.toContain('a');
    db.close();
  });

  it('a failing multi-statement migration is rolled back whole', () => {
    const db = new Database(':memory:');
    migrate(db, ['CREATE TABLE a(x)']);
    expect(() => migrate(db, ['CREATE TABLE a(x)', 'CREATE TABLE b(y); CREATE TABLE a(x);'])).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect(tableNames(db)).not.toContain('b');
    db.close();
  });

  it('a failing migration stops at the last good version', () => {
    const db = new Database(':memory:');
    expect(() => migrate(db, ['CREATE TABLE a(x)', 'CREATE TABLE a(x)'])).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    db.close();
  });
});
