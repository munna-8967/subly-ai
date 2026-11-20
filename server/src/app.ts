import { createServer } from 'node:http';
import path from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from './config.ts';
import { isAppError } from './errors.ts';
import { clientIp, handleCors, RateLimiter, Router, sendError, serveStatic, setSecurityHeaders } from './http.ts';
import { AssetService } from './services/assets.ts';
import { AuthService } from './services/auth.ts';
import { BillingService } from './services/billing.ts';
import { CreditsService } from './services/credits.ts';
import { Db } from './services/db.ts';
import { NotificationService } from './services/notifications.ts';
import { scheduleCleanup } from './services/cleanup.ts';
import { Pipeline } from './services/pipeline.ts';
import { createProviders } from './services/providers/index.ts';
import type { Providers } from './services/providers/types.ts';
import { RenderManager } from './services/render.ts';
import { ProjectStore } from './services/store.ts';
import { registerRoutes } from './routes.ts';

export interface App {
  server: Server;
  store: ProjectStore;
  pipeline: Pipeline;
  renders: RenderManager;
  providers: Providers;
  db: Db;
  auth: AuthService;
  credits: CreditsService;
  billing: BillingService;
  notifications: NotificationService;
  /** start listening; resolves with the actual port (use port 0 in tests) */
  listen(): Promise<number>;
  close(): Promise<void>;
}

/** Build the whole application. Nothing starts listening until `listen()` is called. */
export async function createApp(config: Config, overrides: { providers?: Providers } = {}): Promise<App> {
  const store = new ProjectStore(config.dataDir);
  await store.init();

  const db = new Db(config.dbPath);
  const notifications = new NotificationService(db, config);
  const credits = new CreditsService(db, config, notifications);
  const auth = new AuthService(db, config);
  const billing = new BillingService(db, config, credits, notifications);
  const assets = new AssetService(config, store);

  const providers = overrides.providers ?? createProviders(config);
  const pipeline = new Pipeline(config, store, providers, credits, assets);
  const renders = new RenderManager(config, store, credits);
  await renders.init();
  await Promise.all([pipeline.recover(), renders.recover()]);

  const router = new Router();
  registerRoutes(router, { config, store, pipeline, renders, providers, db, auth, credits, billing, notifications, assets });

  const limiter = new RateLimiter(config.rateLimit.windowMs);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    setSecurityHeaders(res);
    let pathname = '/';
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      pathname = url.pathname;
      const method = req.method ?? 'GET';

      if (pathname.startsWith('/api/')) {
        if (handleCors(config, req, res)) return;
        const ip = clientIp(config, req);

        if (config.rateLimit.enabled) {
          const general = limiter.check(`api:${ip}`, config.rateLimit.max);
          if (!general.allowed) {
            res.setHeader('Retry-After', String(general.retryAfterSeconds));
            sendError(res, 429, 'rate_limited', 'Too many requests. Please slow down and try again shortly.');
            return;
          }
        }

        const matched = router.match(method, pathname);
        if (matched === null) {
          sendError(res, 404, 'not_found', 'Unknown API endpoint.');
          return;
        }
        if (matched === 'method_not_allowed') {
          sendError(res, 405, 'method_not_allowed', 'This endpoint does not support that HTTP method.');
          return;
        }

        if (config.rateLimit.enabled && matched.route.bucket === 'heavy') {
          const heavy = limiter.check(`heavy:${ip}`, config.rateLimit.heavyMax);
          if (!heavy.allowed) {
            res.setHeader('Retry-After', String(heavy.retryAfterSeconds));
            sendError(res, 429, 'rate_limited', 'You have started too many uploads or AI tasks. Please wait a few minutes.');
            return;
          }
        }

        if (config.rateLimit.enabled && matched.route.bucket === 'auth') {
          const auth = limiter.check(`auth:${ip}`, config.auth.attemptsMax);
          if (!auth.allowed) {
            res.setHeader('Retry-After', String(auth.retryAfterSeconds));
            sendError(res, 429, 'rate_limited', 'Too many sign-in attempts. Please wait a few minutes.');
            return;
          }
        }

        await matched.route.handler({ req, res, url, params: matched.params, ip });
        return;
      }

      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, 405, 'method_not_allowed', 'Method not allowed.');
        return;
      }
      if (await serveStatic(config, req, res, pathname)) return;
      // Client-side routes (/editor/<id>, /export/<id>) have no file: serve the app shell.
      if (!path.extname(pathname) && !pathname.split('/').some((s) => s.startsWith('.')) && (await serveStatic(config, req, res, '/index.html'))) return;
      const notBuilt = pathname === '/' || !path.extname(pathname);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(notBuilt ? 'The web client is not built yet. Run "npm run build" (or "npm run dev" for development).' : 'Not found');
    } catch (error) {
      if (isAppError(error)) {
        sendError(res, error.status, error.code, error.message, error.details);
      } else {
        // Details stay in the server log; the browser never sees stack traces.
        console.error('[server] unhandled error:', error);
        sendError(res, 500, 'internal_error', 'Something went wrong on the server. Please try again.');
      }
    } finally {
      if (config.logRequests) {
        // Only the path is logged (never the query string, which may hold a media token).
        console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.requestTimeout = config.uploadTimeoutMs; // total time for one request (uploads are long)
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;

  let stopCleanup: (() => void) | undefined;
  let purgeTimer: NodeJS.Timeout | undefined;

  return {
    server,
    store,
    pipeline,
    renders,
    providers,
    db,
    auth,
    credits,
    billing,
    notifications,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          stopCleanup = scheduleCleanup(config, store, (id) => db.run('DELETE FROM projects WHERE id = ?', id));
          purgeTimer = setInterval(() => auth.purgeExpired(), 3_600_000);
          purgeTimer.unref();
          resolve((server.address() as AddressInfo).port);
        });
      });
    },
    close() {
      stopCleanup?.();
      if (purgeTimer) clearInterval(purgeTimer);
      limiter.close();
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          db.close();
          resolve();
        });
      });
    },
  };
}
