import { randomUUID } from 'node:crypto';
import type { Config } from '../config.ts';
import { AppError } from '../errors.ts';
import type { CreditsService } from './credits.ts';
import type { Db } from './db.ts';
import type { NotificationService } from './notifications.ts';
import { StripeClient } from './payments/stripe.ts';

/**
 * The things that can be bought. PRICES BELOW ARE EXAMPLES: change them here (amounts are in the
 * smallest currency unit, e.g. cents) before you go live.
 */
export interface CatalogItem {
  id: string;
  kind: 'plan' | 'pack';
  name: string;
  description: string;
  /** smallest currency unit */
  amount: number;
  credits: number;
  /** plans renew monthly */
  interval?: 'month';
}

export const CATALOG: CatalogItem[] = [
  { id: 'pro', kind: 'plan', name: 'Pro', description: '300 credits every month', amount: 900, credits: 300, interval: 'month' },
  { id: 'studio', kind: 'plan', name: 'Studio', description: '1,200 credits every month', amount: 2900, credits: 1200, interval: 'month' },
  { id: 'pack_100', kind: 'pack', name: '100 credits', description: 'One-time pack, never expires', amount: 500, credits: 100 },
  { id: 'pack_500', kind: 'pack', name: '500 credits', description: 'One-time pack, never expires', amount: 2000, credits: 500 },
];

export interface Payment {
  id: string;
  createdAt: string;
  provider: string;
  kind: string;
  description: string;
  amount: number;
  currency: string;
  credits: number;
  status: string;
}

interface PaymentRow {
  id: string;
  user_id: string;
  created_at: string;
  provider: string;
  provider_ref: string | null;
  kind: string;
  item_id: string;
  description: string;
  amount: number;
  currency: string;
  credits: number;
  status: string;
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, any> };
}

export class BillingService {
  private readonly db: Db;
  private readonly config: Config;
  private readonly credits: CreditsService;
  private readonly notifications: NotificationService;
  private readonly stripe: StripeClient | null;

  constructor(db: Db, config: Config, credits: CreditsService, notifications: NotificationService) {
    this.db = db;
    this.config = config;
    this.credits = credits;
    this.notifications = notifications;
    this.stripe = config.billing.paymentsMode === 'stripe' ? new StripeClient(config.billing) : null;
  }

  catalog(): (CatalogItem & { currency: string })[] {
    return CATALOG.map((item) => ({ ...item, currency: this.config.billing.currency }));
  }

  private item(id: unknown): CatalogItem {
    const found = CATALOG.find((c) => c.id === id);
    if (!found) throw new AppError(400, 'validation_error', 'Unknown plan or credit pack.');
    return found;
  }

  account(userId: string) {
    const row = this.db.get<{ plan: string; plan_renews_at: string | null; subscription_status: string | null; stripe_customer_id: string | null }>(
      'SELECT plan, plan_renews_at, subscription_status, stripe_customer_id FROM users WHERE id = ?',
      userId,
    );
    return {
      plan: row?.plan ?? 'free',
      planRenewsAt: row?.plan_renews_at ?? null,
      subscriptionStatus: row?.subscription_status ?? null,
      canManageSubscription: this.config.billing.paymentsMode === 'stripe' && !!row?.stripe_customer_id,
    };
  }

  /** Start a purchase. Returns where the browser must go next. */
  async checkout(user: { id: string; email: string }, itemId: unknown): Promise<{ url: string; paymentId: string }> {
    const mode = this.config.billing.paymentsMode;
    if (mode === 'off') throw new AppError(503, 'payments_disabled', this.config.billing.paymentsNote || 'Payments are turned off on this server.');
    const item = this.item(itemId);
    const current = this.account(user.id);
    if (item.kind === 'plan' && current.plan === item.id) throw new AppError(409, 'already_subscribed', `You are already on the ${item.name} plan.`);
    if (item.kind === 'plan' && current.plan !== 'free' && mode === 'stripe') {
      throw new AppError(409, 'already_subscribed', 'You already have a subscription. Use "Manage subscription" to change or cancel it.');
    }
    const paymentId = randomUUID();
    this.db.run(
      'INSERT INTO payments (id, user_id, created_at, provider, kind, item_id, description, amount, currency, credits, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      paymentId,
      user.id,
      new Date().toISOString(),
      mode,
      item.kind,
      item.id,
      item.kind === 'plan' ? `${item.name} plan (monthly)` : `${item.name} pack`,
      item.amount,
      this.config.billing.currency,
      item.credits,
      'pending',
    );
    if (mode === 'demo' || !this.stripe) return { url: `/demo-checkout/${paymentId}`, paymentId };

    const base = this.config.billing.publicUrl;
    const row = this.db.get<{ stripe_customer_id: string | null }>('SELECT stripe_customer_id FROM users WHERE id = ?', user.id);
    const session = await this.stripe.createCheckout({
      paymentId,
      userId: user.id,
      email: user.email,
      customerId: row?.stripe_customer_id,
      mode: item.kind === 'plan' ? 'subscription' : 'payment',
      name: `Subly AI - ${item.name}`,
      amount: item.amount,
      currency: this.config.billing.currency,
      planId: item.kind === 'plan' ? item.id : undefined,
      successUrl: `${base}/billing?checkout=success`,
      cancelUrl: `${base}/billing?checkout=canceled`,
    });
    this.db.run('UPDATE payments SET provider_ref = ? WHERE id = ?', session.id, paymentId);
    return { url: session.url, paymentId };
  }

  async portal(userId: string): Promise<string> {
    const row = this.db.get<{ stripe_customer_id: string | null }>('SELECT stripe_customer_id FROM users WHERE id = ?', userId);
    if (!this.stripe || !row?.stripe_customer_id) throw new AppError(409, 'no_subscription', 'There is no subscription to manage.');
    return this.stripe.createPortal(row.stripe_customer_id, `${this.config.billing.publicUrl}/billing`);
  }

  payments(userId: string, limit = 50): Payment[] {
    return this.db
      .all<PaymentRow>('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', userId, limit)
      .map((r) => ({ id: r.id, createdAt: r.created_at, provider: r.provider, kind: r.kind, description: r.description, amount: r.amount, currency: r.currency, credits: r.credits, status: r.status }));
  }

  private paymentFor(userId: string, paymentId: string): PaymentRow {
    const row = this.db.get<PaymentRow>('SELECT * FROM payments WHERE id = ? AND user_id = ?', paymentId, userId);
    if (!row) throw new AppError(404, 'payment_not_found', 'Payment not found.');
    return row;
  }

  demoDetails(userId: string, paymentId: string) {
    if (this.config.billing.paymentsMode !== 'demo') throw new AppError(404, 'not_found', 'Not found.');
    const p = this.paymentFor(userId, paymentId);
    return { id: p.id, description: p.description, amount: p.amount, currency: p.currency, credits: p.credits, status: p.status };
  }

  /** Demo mode only: pretend the card was charged. NO REAL MONEY MOVES. */
  demoComplete(userId: string, paymentId: string, outcome: 'pay' | 'cancel'): { status: string } {
    if (this.config.billing.paymentsMode !== 'demo') throw new AppError(404, 'not_found', 'Not found.');
    const p = this.paymentFor(userId, paymentId);
    if (p.status !== 'pending') return { status: p.status };
    if (outcome === 'cancel') {
      this.db.run("UPDATE payments SET status = 'canceled' WHERE id = ? AND status = 'pending'", paymentId);
      return { status: 'canceled' };
    }
    this.fulfill(p, `demo:${p.id}`);
    return { status: 'paid' };
  }

  /** Demo mode only: end the (fake) subscription. */
  demoCancelSubscription(userId: string): void {
    if (this.config.billing.paymentsMode !== 'demo') throw new AppError(404, 'not_found', 'Not found.');
    this.db.run("UPDATE users SET plan = 'free', plan_renews_at = NULL, subscription_status = NULL WHERE id = ?", userId);
  }

  /** Mark a payment as paid and give the credits. Safe to run twice (credits are granted once per ref). */
  private fulfill(p: PaymentRow, ref: string): void {
    this.db.transaction(() => {
      this.db.run("UPDATE payments SET status = 'paid', paid_at = ? WHERE id = ?", new Date().toISOString(), p.id);
      const granted = this.credits.grantPaid(p.user_id, p.credits, p.kind === 'plan' ? 'subscription' : 'purchase', p.description, ref);
      if (p.kind === 'plan') {
        const renews = new Date();
        renews.setUTCMonth(renews.getUTCMonth() + 1);
        this.db.run("UPDATE users SET plan = ?, plan_renews_at = ?, subscription_status = 'active' WHERE id = ?", p.item_id, renews.toISOString(), p.user_id);
      }
      if (granted) this.notifications.add(p.user_id, 'purchase', 'Payment received', `${p.credits} credits were added to your account.`);
    });
  }

  // -- Stripe webhook ------------------------------------------------------

  /** Handle one VERIFIED Stripe event. Returns false when it was a duplicate. */
  handleStripeEvent(event: StripeEvent): boolean {
    if (this.db.get('SELECT id FROM webhook_events WHERE id = ?', event.id)) return false;
    this.db.transaction(() => {
      this.db.run('INSERT INTO webhook_events (id, received_at) VALUES (?, ?)', event.id, new Date().toISOString());
      const obj = event.data.object;
      switch (event.type) {
        case 'checkout.session.completed':
          this.onCheckoutCompleted(obj);
          break;
        case 'invoice.paid':
        case 'invoice.payment_succeeded':
          this.onInvoicePaid(obj);
          break;
        case 'customer.subscription.updated':
          this.onSubscriptionChanged(obj);
          break;
        case 'customer.subscription.deleted':
          this.onSubscriptionDeleted(obj);
          break;
        case 'checkout.session.expired': {
          const id = obj.metadata?.payment_id;
          if (typeof id === 'string') this.db.run("UPDATE payments SET status = 'canceled' WHERE id = ? AND status = 'pending'", id);
          break;
        }
        default:
          break;
      }
    });
    return true;
  }

  private onCheckoutCompleted(session: Record<string, any>): void {
    const paymentId = session.metadata?.payment_id ?? session.client_reference_id;
    const p = typeof paymentId === 'string' ? this.db.get<PaymentRow>('SELECT * FROM payments WHERE id = ?', paymentId) : undefined;
    if (!p) return;
    if (typeof session.customer === 'string') this.db.run('UPDATE users SET stripe_customer_id = ? WHERE id = ?', session.customer, p.user_id);
    if (p.kind === 'plan') {
      // Credits and the plan are granted when the invoice is paid (invoice.paid), once per invoice.
      if (typeof session.subscription === 'string') this.db.run('UPDATE users SET stripe_subscription_id = ? WHERE id = ?', session.subscription, p.user_id);
      this.db.run("UPDATE payments SET status = 'processing' WHERE id = ? AND status = 'pending'", p.id);
      return;
    }
    if (session.payment_status === 'paid') this.fulfill(p, `stripe:${session.id}`);
  }

  private onInvoicePaid(invoice: Record<string, any>): void {
    const meta = invoice.subscription_details?.metadata ?? invoice.parent?.subscription_details?.metadata ?? invoice.lines?.data?.[0]?.metadata ?? {};
    const customer = typeof invoice.customer === 'string' ? invoice.customer : undefined;
    let userId: string | undefined = typeof meta.user_id === 'string' ? meta.user_id : undefined;
    if (!userId && customer) userId = this.db.get<{ id: string }>('SELECT id FROM users WHERE stripe_customer_id = ?', customer)?.id;
    const plan = CATALOG.find((c) => c.id === meta.plan && c.kind === 'plan');
    if (!userId || !plan || !this.db.get('SELECT id FROM users WHERE id = ?', userId)) return;
    const ref = `stripe-invoice:${invoice.id}`;
    const existing = this.db.get('SELECT id FROM payments WHERE provider_ref = ?', String(invoice.id));
    if (!existing) {
      // The first invoice belongs to the pending checkout payment: reuse that row.
      const pending = typeof meta.payment_id === 'string' ? this.db.get<PaymentRow>("SELECT * FROM payments WHERE id = ? AND status IN ('pending','processing')", meta.payment_id) : undefined;
      if (pending) {
        this.db.run('UPDATE payments SET provider_ref = ? WHERE id = ?', String(invoice.id), pending.id);
        this.fulfill({ ...pending, provider_ref: String(invoice.id) }, ref);
      } else {
        const id = randomUUID();
        this.db.run(
          "INSERT INTO payments (id, user_id, created_at, provider, provider_ref, kind, item_id, description, amount, currency, credits, status) VALUES (?, ?, ?, 'stripe', ?, 'plan', ?, ?, ?, ?, ?, 'pending')",
          id, userId, new Date().toISOString(), String(invoice.id), plan.id, `${plan.name} plan (renewal)`, Number(invoice.amount_paid ?? plan.amount), this.config.billing.currency, plan.credits,
        );
        this.fulfill(this.db.get<PaymentRow>('SELECT * FROM payments WHERE id = ?', id) as PaymentRow, ref);
      }
    }
    if (typeof invoice.subscription === 'string') this.db.run('UPDATE users SET stripe_subscription_id = ? WHERE id = ?', invoice.subscription, userId);
  }

  private onSubscriptionChanged(sub: Record<string, any>): void {
    if (typeof sub.customer !== 'string') return;
    const end = typeof sub.current_period_end === 'number' ? new Date(sub.current_period_end * 1000).toISOString() : null;
    this.db.run(
      'UPDATE users SET subscription_status = ?, plan_renews_at = COALESCE(?, plan_renews_at) WHERE stripe_customer_id = ?',
      String(sub.status ?? ''), end, sub.customer,
    );
  }

  private onSubscriptionDeleted(sub: Record<string, any>): void {
    if (typeof sub.customer !== 'string') return;
    const user = this.db.get<{ id: string }>('SELECT id FROM users WHERE stripe_customer_id = ?', sub.customer);
    this.db.run("UPDATE users SET plan = 'free', plan_renews_at = NULL, subscription_status = 'canceled', stripe_subscription_id = NULL WHERE stripe_customer_id = ?", sub.customer);
    if (user) this.notifications.add(user.id, 'subscription_ended', 'Subscription ended', 'Your plan has ended. Credits you already have stay available.');
  }
}
