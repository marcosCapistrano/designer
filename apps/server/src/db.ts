import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

/** MIGRATIONS[i] moves PRAGMA user_version from i to i+1. Later plans append; never edit an entry. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE build_chats (app TEXT PRIMARY KEY, claude_session_id TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE build_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT NOT NULL, title TEXT NOT NULL, branch TEXT NOT NULL, base TEXT NOT NULL,
  status TEXT NOT NULL, pr_number INTEGER, pr_url TEXT, head_sha TEXT, ci TEXT NOT NULL DEFAULT 'none', merge_sha TEXT,
  error TEXT, retry_at INTEGER, pending_prompt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX build_tasks_app ON build_tasks (app, id);
CREATE TABLE build_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT NOT NULL, task_id INTEGER REFERENCES build_tasks(id),
  kind TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX build_messages_app ON build_messages (app, id);`,
];

function readVersion(db: Db): number {
  return Number(db.pragma('user_version', { simple: true }));
}

/**
 * Applies every migration past the current PRAGMA user_version, each in its own transaction
 * together with its user_version bump. Returns the final version and rethrows any failure.
 */
export function migrate(db: Db, migrations: readonly string[] = MIGRATIONS): number {
  const current = readVersion(db);
  migrations.slice(current).forEach((sql, offset) => {
    const next = current + offset + 1;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${next}`);
    })();
  });
  return readVersion(db);
}

export function openDb(file: string): Db {
  const inMemory = file === ':memory:';
  if (!inMemory) {
    mkdirSync(dirname(file), { recursive: true });
  }
  const db = new Database(file);
  try {
    if (!inMemory) {
      db.pragma('journal_mode = WAL');
    }
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
