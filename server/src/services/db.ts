import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

/**
 * SQLite (built into Node 22, no extra package) holds everything that must stay consistent:
 * accounts, sessions, the credit ledger, payments and notifications. Projects stay as files
 * (see store.ts) because they hold large videos.
 *
 * The database API of Node is synchronous: every call below is a short local operation, and
 * `transaction()` makes multi-step changes (like spending credits) all-or-nothing.
 */
const MIGRATIONS: string[] = [
  // 1 - accounts, sessions, projects index
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    plan_renews_at TEXT,
    free_credits INTEGER NOT NULL DEFAULT 0,
    free_period TEXT NOT NULL DEFAULT '',
    paid_credits INTEGER NOT NULL DEFAULT 0,
    low_state INTEGER NOT NULL DEFAULT 0,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    subscription_status TEXT
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    user_agent TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
  CREATE INDEX projects_owner ON projects(owner_id, created_at);
  `,
  // 2 - credits, payments, notifications, webhook de-duplication
  `
  CREATE TABLE credit_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    delta INTEGER NOT NULL,
    free_delta INTEGER NOT NULL DEFAULT 0,
    paid_delta INTEGER NOT NULL DEFAULT 0,
    free_after INTEGER NOT NULL,
    paid_after INTEGER NOT NULL,
    period TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    project_id TEXT,
    ref TEXT UNIQUE,
    refund_of INTEGER
  );
  CREATE INDEX ledger_user ON credit_ledger(user_id, id);
  CREATE UNIQUE INDEX ledger_refund_once ON credit_ledger(refund_of) WHERE refund_of IS NOT NULL;
  CREATE TABLE payments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_ref TEXT UNIQUE,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    description TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    paid_at TEXT
  );
  CREATE INDEX payments_user ON payments(user_id, created_at);
  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    read_at TEXT
  );
  CREATE INDEX notifications_user ON notifications(user_id, id);
  CREATE TABLE webhook_events (
    id TEXT PRIMARY KEY,
    received_at TEXT NOT NULL
  );
  `,
];

export type Row = Record<string, unknown>;

export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    const current = (this.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      this.raw.exec('BEGIN');
      try {
        this.raw.exec(MIGRATIONS[version] as string);
        this.raw.exec(`PRAGMA user_version = ${version + 1}`);
        this.raw.exec('COMMIT');
      } catch (error) {
        this.raw.exec('ROLLBACK');
        throw error;
      }
    }
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
    const result = this.raw.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  /** Run `fn` as one all-or-nothing unit. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  close(): void {
    this.raw.close();
  }
}
