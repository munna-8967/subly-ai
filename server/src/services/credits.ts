import { currentPeriod, nextPeriodStart } from '../../../shared/credits.js';
import type { Config } from '../config.ts';
import { AppError } from '../errors.ts';
import type { Db } from './db.ts';
import type { NotificationService } from './notifications.ts';

export interface Balance {
  free: number;
  paid: number;
  total: number;
  /** when the free credits are renewed (and unused ones expire) */
  freeResetsAt: string;
  freeMonthly: number;
  plan: string;
}

export interface LedgerEntry {
  id: number;
  createdAt: string;
  kind: string;
  delta: number;
  freeAfter: number;
  paidAfter: number;
  description: string;
  projectId: string | null;
}

interface UserCredits {
  id: string;
  plan: string;
  free_credits: number;
  free_period: string;
  paid_credits: number;
}

interface LedgerRow {
  id: number;
  created_at: string;
  kind: string;
  delta: number;
  free_delta: number;
  paid_delta: number;
  free_after: number;
  paid_after: number;
  period: string;
  description: string;
  project_id: string | null;
  refund_of: number | null;
}

/**
 * Credits come in two buckets:
 *  - free:  FREE_MONTHLY_CREDITS granted every calendar month (UTC); unused ones EXPIRE at month end.
 *  - paid:  bought packs / subscription grants; never expire.
 * Spending uses free credits first. Every change is one ledger row, written in the same SQLite
 * transaction as the balance change, so the ledger always adds up to the balance.
 */
export class CreditsService {
  private readonly db: Db;
  private readonly config: Config;
  private readonly notifications: NotificationService;

  constructor(db: Db, config: Config, notifications: NotificationService) {
    this.db = db;
    this.config = config;
    this.notifications = notifications;
  }

  private load(userId: string): UserCredits {
    const row = this.db.get<UserCredits>('SELECT id, plan, free_credits, free_period, paid_credits FROM users WHERE id = ?', userId);
    if (!row) throw new AppError(401, 'not_signed_in', 'Please sign in.');
    return row;
  }

  private writeLedger(
    userId: string,
    kind: string,
    free: number,
    paid: number,
    after: { free: number; paid: number },
    extra: { description?: string; projectId?: string | null; ref?: string | null; refundOf?: number | null; period?: string } = {},
  ): number {
    return this.db.run(
      `INSERT INTO credit_ledger (user_id, created_at, kind, delta, free_delta, paid_delta, free_after, paid_after, period, description, project_id, ref, refund_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      new Date().toISOString(),
      kind,
      free + paid,
      free,
      paid,
      after.free,
      after.paid,
      extra.period ?? '',
      extra.description ?? '',
      extra.projectId ?? null,
      extra.ref ?? null,
      extra.refundOf ?? null,
    ).lastInsertRowid;
  }

  /** Lazily start a new month: expire the unused free credits and grant a fresh allowance. */
  private rollPeriod(user: UserCredits, now: Date): UserCredits {
    const period = currentPeriod(now);
    if (user.free_period === period) return user;
    const monthly = this.config.billing.freeMonthlyCredits;
    let paid = user.paid_credits;
    let free = user.free_credits;
    if (free > 0) {
      this.writeLedger(user.id, 'free_expire', -free, 0, { free: 0, paid }, { description: `Unused free credits of ${user.free_period || 'last period'} expired`, period: user.free_period });
      free = 0;
    }
    free = monthly;
    this.writeLedger(user.id, 'free_grant', monthly, 0, { free, paid }, { description: `Free monthly credits (${period})`, period });
    this.db.run('UPDATE users SET free_credits = ?, free_period = ? WHERE id = ?', free, period, user.id);
    return { ...user, free_credits: free, free_period: period, paid_credits: paid };
  }

  balance(userId: string, now = new Date()): Balance {
    return this.db.transaction(() => {
      const user = this.rollPeriod(this.load(userId), now);
      return {
        free: user.free_credits,
        paid: user.paid_credits,
        total: user.free_credits + user.paid_credits,
        freeResetsAt: nextPeriodStart(now),
        freeMonthly: this.config.billing.freeMonthlyCredits,
        plan: user.plan,
      };
    });
  }

  /** Take `amount` credits (free first). Throws 402 when the balance is too small. Returns the ledger id to refund later. */
  spend(userId: string, amount: number, description: string, projectId?: string, now = new Date()): number {
    if (!Number.isInteger(amount) || amount < 1) throw new Error('spend: amount must be a positive integer');
    let id: number;
    try {
      id = this.spendNow(userId, amount, description, projectId, now);
    } catch (error) {
      // Trying to spend with an empty balance is the moment the "out of credits" notice matters.
      if (error instanceof AppError && error.code === 'insufficient_credits') this.notifications.evaluateBalance(userId, this.balance(userId, now).total);
      throw error;
    }
    this.notifications.evaluateBalance(userId, this.balance(userId, now).total);
    return id;
  }

  private spendNow(userId: string, amount: number, description: string, projectId: string | undefined, now: Date): number {
    return this.db.transaction(() => {
      const user = this.rollPeriod(this.load(userId), now);
      const total = user.free_credits + user.paid_credits;
      if (total < amount) {
        throw new AppError(402, 'insufficient_credits', `This needs ${amount} credit${amount === 1 ? '' : 's'} but you have ${total}. Buy credits or wait for the monthly renewal.`, { needed: amount, available: total });
      }
      const fromFree = Math.min(user.free_credits, amount);
      const fromPaid = amount - fromFree;
      const after = { free: user.free_credits - fromFree, paid: user.paid_credits - fromPaid };
      this.db.run('UPDATE users SET free_credits = ?, paid_credits = ? WHERE id = ?', after.free, after.paid, userId);
      return this.writeLedger(userId, 'spend', -fromFree, -fromPaid, after, { description, projectId, period: user.free_period });
    });
  }

  /** Give back a spend (job failed or was cancelled). Safe to call twice: the second call does nothing. */
  refund(ledgerId: number, reason: string, now = new Date()): boolean {
    let userId: string | null = null;
    const refunded = this.db.transaction(() => {
      const entry = this.db.get<LedgerRow & { user_id: string }>('SELECT * FROM credit_ledger WHERE id = ? AND kind = ?', ledgerId, 'spend');
      if (!entry) return false;
      if (this.db.get('SELECT id FROM credit_ledger WHERE refund_of = ?', ledgerId)) return false;
      userId = entry.user_id;
      const user = this.rollPeriod(this.load(entry.user_id), now);
      // Free credits only go back to the free bucket while the month they came from is still running.
      const backToFree = entry.period === user.free_period ? -entry.free_delta : 0;
      const backToPaid = -entry.paid_delta + (-entry.free_delta - backToFree);
      const after = { free: user.free_credits + backToFree, paid: user.paid_credits + backToPaid };
      this.db.run('UPDATE users SET free_credits = ?, paid_credits = ? WHERE id = ?', after.free, after.paid, entry.user_id);
      this.writeLedger(entry.user_id, 'refund', backToFree, backToPaid, after, { description: reason, projectId: entry.project_id, refundOf: ledgerId, period: user.free_period });
      return true;
    });
    if (refunded && userId) this.notifications.evaluateBalance(userId, this.balance(userId, now).total);
    return refunded;
  }

  /** Add paid credits (purchase or subscription renewal). `ref` makes it idempotent: the same ref is only ever granted once. */
  grantPaid(userId: string, amount: number, kind: 'purchase' | 'subscription' | 'adjust', description: string, ref: string | null, now = new Date()): boolean {
    const granted = this.db.transaction(() => {
      if (ref && this.db.get('SELECT id FROM credit_ledger WHERE ref = ?', ref)) return false;
      const user = this.rollPeriod(this.load(userId), now);
      const after = { free: user.free_credits, paid: user.paid_credits + amount };
      this.db.run('UPDATE users SET paid_credits = ? WHERE id = ?', after.paid, userId);
      this.writeLedger(userId, kind, 0, amount, after, { description, ref });
      return true;
    });
    if (granted) this.notifications.evaluateBalance(userId, this.balance(userId, now).total);
    return granted;
  }

  ledger(userId: string, limit = 50, before?: number): LedgerEntry[] {
    const rows = before
      ? this.db.all<LedgerRow>('SELECT * FROM credit_ledger WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?', userId, before, limit)
      : this.db.all<LedgerRow>('SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, limit);
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      kind: r.kind,
      delta: r.delta,
      freeAfter: r.free_after,
      paidAfter: r.paid_after,
      description: r.description,
      projectId: r.project_id,
    }));
  }
}
