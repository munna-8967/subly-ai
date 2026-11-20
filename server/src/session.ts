import type { Config } from './config.ts';
import { AppError } from './errors.ts';
import type { Ctx } from './http.ts';
import { parseCookies, SESSION_COOKIE } from './services/auth.ts';
import type { AuthService, User } from './services/auth.ts';

export function sessionTokenOf(ctx: Ctx): string | undefined {
  return parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE];
}

/**
 * CSRF defence: browsers cannot add a custom header to a cross-site form or <img> request, so every
 * state-changing request must carry it. Together with SameSite=Lax cookies this blocks forged requests.
 */
export function checkCsrf(ctx: Ctx): void {
  const method = ctx.req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  if (ctx.req.headers['x-requested-with'] !== 'subly') {
    throw new AppError(403, 'csrf', 'Request rejected (missing security header).');
  }
}

export function currentUser(ctx: Ctx, auth: AuthService): User | null {
  return auth.userForToken(sessionTokenOf(ctx));
}

export function requireUser(ctx: Ctx, auth: AuthService): User {
  checkCsrf(ctx);
  const user = currentUser(ctx, auth);
  if (!user) throw new AppError(401, 'not_signed_in', 'Please sign in to continue.');
  return user;
}

export function useSecureCookie(config: Config, ctx: Ctx): boolean {
  if (config.auth.cookieSecure !== 'auto') return config.auth.cookieSecure;
  const proto = config.trustProxy ? ctx.req.headers['x-forwarded-proto'] : undefined;
  return proto === 'https' || config.billing.publicUrl.startsWith('https://');
}
