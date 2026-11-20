import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Config } from './config.ts';
import { AppError } from './errors.ts';

// ---------------------------------------------------------------------------
// Context + router
// ---------------------------------------------------------------------------

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  ip: string;
}

export type Bucket = 'api' | 'heavy' | 'auth';

export type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
  /** rate-limit bucket */
  bucket: Bucket;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, bucket: Bucket = 'api'): void {
    const keys: string[] = [];
    const source = pattern.replace(/:([A-Za-z]+)/g, (_m, key: string) => {
      keys.push(key);
      return '([^/]+)';
    });
    this.routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler, bucket });
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | 'method_not_allowed' | null {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        try {
          params[key] = decodeURIComponent(m[i + 1]);
        } catch {
          params[key] = '';
        }
      });
      return { route, params };
    }
    return pathMatched ? 'method_not_allowed' : null;
  }
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

/** Consistent error body: { error: { code, message, details? } } */
export function sendError(res: ServerResponse, status: number, code: string, message: string, details?: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, status, { error: { code, message, ...(details !== undefined ? { details } : {}) } });
}

/**
 * Read and parse a JSON request body with a size limit and a deadline.
 * Returns {} for an empty body.
 */
export function readJsonBody(req: IncomingMessage, limitBytes = 64 * 1024, timeoutMs = 20_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const type = req.headers['content-type'] ?? '';
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limitBytes) {
      reject(new AppError(413, 'payload_too_large', 'The request body is too large.'));
      return;
    }
    if (declared > 0 && !/^application\/json\b/i.test(type)) {
      reject(new AppError(415, 'unsupported_media_type', 'Send the request body as application/json.'));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new AppError(408, 'request_timeout', 'The request took too long to send.')));
      req.destroy();
    }, timeoutMs);

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        finish(() => reject(new AppError(413, 'payload_too_large', 'The request body is too large.')));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      finish(() => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.trim() === '') {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new AppError(400, 'invalid_json', 'The request body is not valid JSON.'));
        }
      });
    });
    req.on('error', () => finish(() => reject(new AppError(400, 'request_aborted', 'The request was interrupted.'))));
  });
}

/** The raw bytes of a small body (needed to verify webhook signatures, which cover the exact bytes). */
export function readRawBody(req: IncomingMessage, limitBytes = 256 * 1024, timeoutMs = 20_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new AppError(408, 'request_timeout', 'The request took too long to send.')));
      req.destroy();
    }, timeoutMs);
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        finish(() => reject(new AppError(413, 'payload_too_large', 'The request body is too large.')));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(() => resolve(Buffer.concat(chunks))));
    req.on('error', () => finish(() => reject(new AppError(400, 'request_aborted', 'The request was interrupted.'))));
  });
}

// ---------------------------------------------------------------------------
// Security headers + CORS
// ---------------------------------------------------------------------------

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

export function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // Media URLs may carry a token in the query string: never leak it via Referer.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

/** Returns true when the request was a CORS preflight that has been answered. */
export function handleCors(config: Config, req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (!config.allowedOrigins.includes(origin.replace(/\/$/, ''))) return false;

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With, X-File-Name, Stripe-Signature');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rate limiting (fixed window, in memory, per client IP)
// ---------------------------------------------------------------------------

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private windowMs: number;
  private timer: NodeJS.Timeout;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
    this.timer = setInterval(() => this.purge(), Math.min(windowMs, 60_000));
    this.timer.unref();
  }

  check(key: string, max: number, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    entry.count += 1;
    if (entry.count > max) return { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private purge(now = Date.now()): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }

  close(): void {
    clearInterval(this.timer);
  }
}

export function clientIp(config: Config, req: IncomingMessage): string {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Static files and ranged file downloads
// ---------------------------------------------------------------------------

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Serve a file from one of the public folders. Returns false when nothing matched
 * (so the caller can answer 404). Path traversal and dotfiles are rejected.
 */
export async function serveStatic(config: Config, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return false;

  let root = config.clientDir;
  let relative = decoded;
  if (decoded.startsWith('/shared/')) {
    root = config.sharedDir;
    relative = decoded.slice('/shared'.length);
  }
  if (relative === '/' || relative === '') relative = '/index.html';

  const segments = relative.split('/').filter(Boolean);
  if (segments.some((s) => s.startsWith('.') || s === '..')) return false;

  const target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) return false;

  const type = STATIC_TYPES[path.extname(target).toLowerCase()];
  if (!type) return false;

  let info;
  try {
    info = await stat(target);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  const etag = `W/"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    res.end();
    return true;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  await pipeline(createReadStream(target), res).catch(() => undefined);
  return true;
}

export interface FileOptions {
  contentType: string;
  /** when set, the browser downloads the file under this (already sanitized) name */
  downloadName?: string;
}

/** Stream a file with HTTP Range support (needed for video seeking). */
export async function sendFile(req: IncomingMessage, res: ServerResponse, filePath: string, options: FileOptions): Promise<void> {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new AppError(404, 'file_not_found', 'The requested file no longer exists.');
  }
  const size = info.size;
  const headers: Record<string, string | number> = {
    'Content-Type': options.contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
  };
  if (options.downloadName) {
    const ascii = options.downloadName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    headers['Content-Disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(options.downloadName)}`;
  }

  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    if (m[1] === '') {
      // suffix range: last N bytes
      const suffix = Number(m[2]);
      start = Math.max(0, size - suffix);
    } else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(size - 1, Number(m[2]));
    }
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }

  headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return;
  }
  await pipeline(createReadStream(filePath, { start, end }), res).catch(() => undefined);
}
