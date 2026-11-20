import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BillingConfig } from '../../config.ts';
import { AppError } from '../../errors.ts';

/**
 * Minimal Stripe client using fetch (no SDK, so no extra npm package).
 * Only used when PAYMENTS_MODE=stripe. It has been tested against a local MOCK of Stripe only,
 * never against the real service: test it yourself with Stripe test keys (see README).
 */

/** Stripe wants application/x-www-form-urlencoded with bracket notation for nested data. */
export function encodeForm(data: Record<string, unknown>, prefix = '', out: [string, string][] = []): [string, string][] {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item !== null && typeof item === 'object') encodeForm(item as Record<string, unknown>, `${name}[${i}]`, out);
        else out.push([`${name}[${i}]`, String(item)]);
      });
    } else if (typeof value === 'object') {
      encodeForm(value as Record<string, unknown>, name, out);
    } else {
      out.push([name, String(value)]);
    }
  }
  return out;
}

export class StripeClient {
  private readonly cfg: BillingConfig;

  constructor(cfg: BillingConfig) {
    this.cfg = cfg;
  }

  private async post(path: string, data: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>> {
    const body = new URLSearchParams(encodeForm(data)).toString();
    let response: Response;
    try {
      response = await fetch(`${this.cfg.stripe.apiBase}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cfg.stripe.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new AppError(502, 'payment_provider_unreachable', 'The payment provider could not be reached. Try again in a moment.');
    }
    const json = (await response.json().catch(() => ({}))) as { error?: { message?: string } } & Record<string, unknown>;
    if (!response.ok) {
      console.error('[stripe] error', response.status, json.error?.message);
      throw new AppError(502, 'payment_provider_error', 'The payment provider refused the request. Check the Stripe keys on the server.');
    }
    return json;
  }

  async createCheckout(input: {
    paymentId: string;
    userId: string;
    email: string;
    customerId?: string | null;
    mode: 'payment' | 'subscription';
    name: string;
    amount: number;
    currency: string;
    planId?: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ id: string; url: string }> {
    const metadata = { payment_id: input.paymentId, user_id: input.userId, ...(input.planId ? { plan: input.planId } : {}) };
    const data: Record<string, unknown> = {
      mode: input.mode,
      client_reference_id: input.paymentId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: input.currency,
            unit_amount: input.amount,
            product_data: { name: input.name },
            ...(input.mode === 'subscription' ? { recurring: { interval: 'month' } } : {}),
          },
        },
      ],
      ...(input.mode === 'subscription' ? { subscription_data: { metadata } } : {}),
      ...(input.customerId ? { customer: input.customerId } : { customer_email: input.email }),
    };
    const session = await this.post('/v1/checkout/sessions', data, `checkout-${input.paymentId}`);
    if (typeof session.id !== 'string' || typeof session.url !== 'string') {
      throw new AppError(502, 'payment_provider_error', 'The payment provider returned an unexpected answer.');
    }
    return { id: session.id, url: session.url };
  }

  async createPortal(customerId: string, returnUrl: string): Promise<string> {
    const session = await this.post('/v1/billing_portal/sessions', { customer: customerId, return_url: returnUrl });
    if (typeof session.url !== 'string') throw new AppError(502, 'payment_provider_error', 'The payment provider returned an unexpected answer.');
    return session.url;
  }
}

/** Check a `Stripe-Signature` header against the exact raw body. Throws AppError(400) when invalid. */
export function verifyStripeSignature(raw: Buffer, header: string | undefined, secret: string, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): void {
  const bad = () => new AppError(400, 'bad_signature', 'Webhook signature check failed.');
  if (!header) throw bad();
  let timestamp = 0;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') timestamp = Number(v);
    if (k === 'v1' && v) signatures.push(v);
  }
  if (!Number.isFinite(timestamp) || timestamp <= 0 || signatures.length === 0) throw bad();
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) throw bad();
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest();
  const ok = signatures.some((sig) => {
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!ok) throw bad();
}

/** Build a valid header (used by tests and by the mock). */
export function signStripePayload(raw: string | Buffer, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}
