import type { Config } from '../config.ts';
import type { Db } from './db.ts';

export interface Notification {
  id: number;
  createdAt: string;
  kind: string;
  title: string;
  body: string;
  read: boolean;
}

interface NotificationRow {
  id: number;
  created_at: string;
  kind: string;
  title: string;
  body: string;
  read_at: string | null;
}

/** In-app notifications. (No e-mail is sent: that would need an e-mail provider.) */
export class NotificationService {
  private readonly db: Db;
  private readonly config: Config;

  constructor(db: Db, config: Config) {
    this.db = db;
    this.config = config;
  }

  add(userId: string, kind: string, title: string, body: string): void {
    this.db.run(
      'INSERT INTO notifications (user_id, created_at, kind, title, body) VALUES (?, ?, ?, ?, ?)',
      userId,
      new Date().toISOString(),
      kind,
      title,
      body,
    );
  }

  /**
   * Low-credit state machine: 0 = fine, 1 = "running low" was shown, 2 = "out of credits" was shown.
   * Each warning is shown once per dip, and re-arms when the balance goes back above the threshold.
   */
  evaluateBalance(userId: string, total: number): void {
    const row = this.db.get<{ low_state: number }>('SELECT low_state FROM users WHERE id = ?', userId);
    if (!row) return;
    const threshold = this.config.billing.lowCreditThreshold;
    let next = row.low_state;
    if (total <= 0) {
      if (row.low_state < 2) {
        this.add(userId, 'credits_empty', 'You are out of credits', 'Buy a credit pack or subscribe to keep generating subtitles. Manual editing and SRT/VTT/TXT export are still free.');
      }
      next = 2;
    } else if (total <= threshold) {
      if (row.low_state < 1) {
        this.add(userId, 'credits_low', 'Credits are running low', `You have ${total} credit${total === 1 ? '' : 's'} left.`);
      }
      next = row.low_state === 2 ? 1 : Math.max(row.low_state, 1);
    } else {
      next = 0;
    }
    if (next !== row.low_state) this.db.run('UPDATE users SET low_state = ? WHERE id = ?', next, userId);
  }

  list(userId: string, limit = 30): { items: Notification[]; unread: number } {
    const rows = this.db.all<NotificationRow>('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, limit);
    const unread = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', userId)?.n ?? 0;
    return {
      items: rows.map((r) => ({ id: r.id, createdAt: r.created_at, kind: r.kind, title: r.title, body: r.body, read: r.read_at !== null })),
      unread,
    };
  }

  markAllRead(userId: string): void {
    this.db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', new Date().toISOString(), userId);
  }
}
