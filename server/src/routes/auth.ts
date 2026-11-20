import { AppError } from '../errors.ts';
import { readJsonBody, sendJson, sendNoContent } from '../http.ts';
import type { Router } from '../http.ts';
import { clearedSessionCookie, sessionCookie } from '../services/auth.ts';
import type { Deps } from '../routes.ts';
import { checkCsrf, currentUser, requireUser, sessionTokenOf, useSecureCookie } from '../session.ts';

function obj(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'validation_error', 'The request body must be a JSON object.');
  return body as Record<string, unknown>;
}

export function registerAuthRoutes(router: Router, deps: Deps): void {
  const { config, auth, credits, billing, notifications } = deps;

  const accountView = (user: { id: string; email: string; name: string; createdAt: string }) => ({
    user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt },
    credits: credits.balance(user.id),
    subscription: billing.account(user.id),
    unreadNotifications: notifications.list(user.id, 1).unread,
  });

  // Who is signed in? (200 with user:null when nobody is, so the page can decide without an error.)
  router.add('GET', '/api/auth/me', (ctx) => {
    const user = currentUser(ctx, auth);
    sendJson(ctx.res, 200, user ? accountView(user) : { user: null });
  });

  const startSession = (ctx: Parameters<typeof useSecureCookie>[1], userId: string) => {
    const { token, expiresAt } = auth.createSession(userId, String(ctx.req.headers['user-agent'] ?? ''));
    ctx.res.setHeader('Set-Cookie', sessionCookie(token, expiresAt, useSecureCookie(config, ctx)));
  };

  router.add(
    'POST',
    '/api/auth/register',
    async (ctx) => {
      checkCsrf(ctx);
      const body = obj(await readJsonBody(ctx.req, 8 * 1024));
      const user = await auth.register(body.email, body.password, body.name);
      startSession(ctx, user.id);
      sendJson(ctx.res, 201, accountView(user));
    },
    'auth',
  );

  router.add(
    'POST',
    '/api/auth/login',
    async (ctx) => {
      checkCsrf(ctx);
      const body = obj(await readJsonBody(ctx.req, 8 * 1024));
      const user = await auth.login(body.email, body.password);
      startSession(ctx, user.id);
      sendJson(ctx.res, 200, accountView(user));
    },
    'auth',
  );

  router.add('POST', '/api/auth/logout', (ctx) => {
    checkCsrf(ctx);
    auth.destroySession(sessionTokenOf(ctx));
    ctx.res.setHeader('Set-Cookie', clearedSessionCookie(useSecureCookie(config, ctx)));
    sendNoContent(ctx.res);
  });

  router.add(
    'POST',
    '/api/auth/password',
    async (ctx) => {
      const user = requireUser(ctx, auth);
      const body = obj(await readJsonBody(ctx.req, 8 * 1024));
      await auth.changePassword(user.id, body.currentPassword, body.newPassword, sessionTokenOf(ctx));
      sendNoContent(ctx.res);
    },
    'auth',
  );
}
