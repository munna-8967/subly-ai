import { AppError } from '../errors.ts';
import { readJsonBody, readRawBody, sendJson, sendNoContent } from '../http.ts';
import type { Router } from '../http.ts';
import { verifyStripeSignature } from '../services/payments/stripe.ts';
import type { Deps } from '../routes.ts';
import { requireUser } from '../session.ts';

function obj(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'validation_error', 'The request body must be a JSON object.');
  return body as Record<string, unknown>;
}

export function registerBillingRoutes(router: Router, deps: Deps): void {
  const { config, auth, credits, billing, notifications } = deps;

  router.add('GET', '/api/billing', (ctx) => {
    const user = requireUser(ctx, auth);
    sendJson(ctx.res, 200, {
      mode: config.billing.paymentsMode,
      note: config.billing.paymentsNote,
      currency: config.billing.currency,
      catalog: billing.catalog(),
      costs: config.billing.costs,
      lowCreditThreshold: config.billing.lowCreditThreshold,
      credits: credits.balance(user.id),
      subscription: billing.account(user.id),
    });
  });

  router.add('GET', '/api/billing/ledger', (ctx) => {
    const user = requireUser(ctx, auth);
    const before = Number(ctx.url.searchParams.get('before')) || undefined;
    sendJson(ctx.res, 200, { entries: credits.ledger(user.id, 50, before) });
  });

  router.add('GET', '/api/billing/payments', (ctx) => {
    const user = requireUser(ctx, auth);
    sendJson(ctx.res, 200, { payments: billing.payments(user.id) });
  });

  router.add('POST', '/api/billing/checkout', async (ctx) => {
    const user = requireUser(ctx, auth);
    const body = obj(await readJsonBody(ctx.req, 2 * 1024));
    sendJson(ctx.res, 200, await billing.checkout(user, body.itemId));
  }, 'heavy');

  router.add('POST', '/api/billing/portal', async (ctx) => {
    const user = requireUser(ctx, auth);
    sendJson(ctx.res, 200, { url: await billing.portal(user.id) });
  });

  // Demo checkout (PAYMENTS_MODE=demo): no real money, for testing the whole flow.
  router.add('GET', '/api/billing/demo/:id', (ctx) => {
    const user = requireUser(ctx, auth);
    sendJson(ctx.res, 200, { payment: billing.demoDetails(user.id, ctx.params.id) });
  });
  router.add('POST', '/api/billing/demo/:id/pay', (ctx) => {
    const user = requireUser(ctx, auth);
    sendJson(ctx.res, 200, billing.demoComplete(user.id, ctx.params.id, 'pay'));
  });
  router.add('POST', '/api/billing/demo/:id/cancel', (ctx) => {
    const user = requireUser(ctx, auth);
    sendJson(ctx.res, 200, billing.demoComplete(user.id, ctx.params.id, 'cancel'));
  });
  router.add('POST', '/api/billing/demo-cancel-subscription', (ctx) => {
    const user = requireUser(ctx, auth);
    billing.demoCancelSubscription(user.id);
    sendNoContent(ctx.res);
  });

  // Stripe calls this itself (no cookie, no CSRF header): the signature is the authentication.
  router.add('POST', '/api/billing/webhook', async (ctx) => {
    if (config.billing.paymentsMode !== 'stripe') throw new AppError(404, 'not_found', 'Unknown API endpoint.');
    const raw = await readRawBody(ctx.req);
    const header = ctx.req.headers['stripe-signature'];
    verifyStripeSignature(raw, Array.isArray(header) ? header[0] : header, config.billing.stripe.webhookSecret);
    let event: { id?: unknown; type?: unknown; data?: { object?: unknown } };
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new AppError(400, 'invalid_json', 'The request body is not valid JSON.');
    }
    if (typeof event.id !== 'string' || typeof event.type !== 'string' || typeof event.data?.object !== 'object' || event.data.object === null) {
      throw new AppError(400, 'validation_error', 'Unexpected event shape.');
    }
    const duplicate = !billing.handleStripeEvent({ id: event.id, type: event.type, data: { object: event.data.object as Record<string, any> } });
    sendJson(ctx.res, 200, { received: true, duplicate });
  });

  router.add('GET', '/api/notifications', (ctx) => {
    const user = requireUser(ctx, auth);
    sendJson(ctx.res, 200, notifications.list(user.id));
  });
  router.add('POST', '/api/notifications/read', (ctx) => {
    const user = requireUser(ctx, auth);
    notifications.markAllRead(user.id);
    sendNoContent(ctx.res);
  });
}
