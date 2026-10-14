### Task 4: SQLite and migrations

**Files:**
- Create: `apps/server/src/db.ts`
- Test: `apps/server/src/db.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces:

```ts
import Database from 'better-sqlite3';
export type Db = Database.Database;
/** MIGRATIONS[i] moves PRAGMA user_version from i to i+1. Later plans append; never edit an entry. */
export const MIGRATIONS: readonly string[];
export function migrate(db: Db, migrations?: readonly string[] /* default MIGRATIONS */): number;
export function openDb(file: string): Db;
```

`migrate` runs each pending migration in its own `db.transaction`, which executes the SQL and then `PRAGMA user_version = i+1`. It returns the final version and rethrows errors. `openDb`:
1. Unless the file is `':memory:'`, run `mkdirSync(dirname(file), { recursive: true })` and `pragma('journal_mode = WAL')`.
2. Then `pragma('foreign_keys = ON')` and `pragma('busy_timeout = 5000')`.
3. Then `migrate`.

`MIGRATIONS[0]` (exact):

```sql
CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE build_chats (app TEXT PRIMARY KEY, claude_session_id TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE build_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT NOT NULL, title TEXT NOT NULL, branch TEXT NOT NULL, base TEXT NOT NULL,
  status TEXT NOT NULL, pr_number INTEGER, pr_url TEXT, head_sha TEXT, ci TEXT NOT NULL DEFAULT 'none', merge_sha TEXT,
  error TEXT, retry_at INTEGER, pending_prompt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX build_tasks_app ON build_tasks (app, id);
CREATE TABLE build_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT NOT NULL, task_id INTEGER REFERENCES build_tasks(id),
  kind TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX build_messages_app ON build_messages (app, id);
```

- [ ] **Step 1: Write the failing tests:**
  - `fresh db migrates to the latest version`: `openDb(':memory:')` → `pragma('user_version', { simple: true }) === MIGRATIONS.length`, and `sqlite_master` lists `auth_sessions`, `build_chats`, `build_tasks` and `build_messages`.
  - `migrate is idempotent`: a second `migrate(db)` returns the same version.
  - `applies only pending migrations`: `migrate(db, ['CREATE TABLE a(x)'])`, then `migrate(db, ['CREATE TABLE a(x)', 'CREATE TABLE b(y)'])` → returns 2, and both tables exist.
  - `a failing migration stops at the last good version`: on a fresh `new Database(':memory:')`, `migrate(db, ['CREATE TABLE a(x)', 'CREATE TABLE a(x)'])` throws and `user_version === 1`.
  - `file db uses WAL and creates its folder`: `openDb(join(tmp, 'sub', 'hub.sqlite'))` → `pragma('journal_mode', { simple: true }) === 'wal'`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/db.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `db.ts`.
- [ ] **Step 4: Run** the same command. Expected: 5 pass.
- [ ] **Step 5: Commit** `apps/server/src/db.ts apps/server/src/db.test.ts` as `feat(server): sqlite with append-only migrations`, with the attribution trailer your harness provides.

---

