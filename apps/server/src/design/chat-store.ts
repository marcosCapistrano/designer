import type { DesignMessage } from '@hub/protocol';
import type { Db } from '../db.js';
export class DesignChatStore {
  constructor(private readonly db: Db, private readonly now = Date.now) {}
  session(app: string): string | undefined { return (this.db.prepare('SELECT claude_session_id AS id FROM design_chats WHERE app=?').get(app) as { id: string | null } | undefined)?.id ?? undefined; }
  setSession(app: string, id: string): void { this.db.prepare('INSERT INTO design_chats(app,claude_session_id) VALUES (?,?) ON CONFLICT(app) DO UPDATE SET claude_session_id=excluded.claude_session_id').run(app,id); }
  messages(app: string): DesignMessage[] { return this.db.prepare('SELECT * FROM (SELECT id,app,kind,text,at FROM design_messages WHERE app=? ORDER BY id DESC LIMIT 200) ORDER BY id').all(app) as DesignMessage[]; }
  add(app: string, kind: DesignMessage['kind'], text: string): DesignMessage {
    const at = this.now();
    const row = this.db.prepare('INSERT INTO design_messages(app,kind,text,at) VALUES (?,?,?,?)').run(app,kind,text,at);
    return { id: Number(row.lastInsertRowid), app, kind, text, at };
  }
}
