import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Config } from '../config.ts';
import { AppError } from '../errors.ts';
import type { Db } from './db.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const SESSION_COOKIE = 'subly_session';

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  plan: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  created_at: string;
  plan: string;
  password_hash: string;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, saltHex, keyHex] = stored.split('$');
  if (kind !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A hash that is checked when the e-mail does not exist, so timing does not reveal which e-mails are registered. */
const DUMMY_HASH = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;

export class AuthService {
  private readonly db: Db;
  private readonly config: Config;

  constructor(db: Db, config: Config) {
    this.db = db;
    this.config = config;
  }

  private toUser(row: UserRow): User {
    return { id: row.id, email: row.email, name: row.name, createdAt: row.created_at, plan: row.plan };
  }

  validateCredentials(email: unknown, password: unknown, name?: unknown): { email: string; password: string; name: string } {
    const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(e)) throw new AppError(400, 'invalid_email', 'Enter a valid e-mail address.');
    if (typeof password !== 'string' || password.length < 8) {
      throw new AppError(400, 'weak_password', 'Use a password with at least 8 characters.');
    }
    if (password.length > 200) throw new AppError(400, 'weak_password', 'That password is too long (200 characters at most).');
    const n = typeof name === 'string' ? name.trim().slice(0, 80) : '';
    return { email: e, password, name: n || e.split('@')[0] || 'User' };
  }

  async register(emailIn: unknown, passwordIn: unknown, nameIn: unknown): Promise<User> {
    const { email, password, name } = this.validateCredentials(emailIn, passwordIn, nameIn);
    if (this.db.get('SELECT id FROM users WHERE email = ?', email)) {
      throw new AppError(409, 'email_taken', 'An account with this e-mail already exists. Sign in instead.');
    }
    const hash = await hashPassword(password);
    const id = randomUUID();
    try {
      this.db.run(
        'INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
        id,
        email,
        name,
        hash,
        new Date().toISOString(),
      );
    } catch {
      throw new AppError(409, 'email_taken', 'An account with this e-mail already exists. Sign in instead.');
    }
    return { id, email, name, createdAt: new Date().toISOString(), plan: 'free' };
  }

  async login(emailIn: unknown, passwordIn: unknown): Promise<User> {
    const email = typeof emailIn === 'string' ? emailIn.trim().toLowerCase() : '';
    const password = typeof passwordIn === 'string' ? passwordIn.slice(0, 200) : '';
    const row = this.db.get<UserRow>('SELECT * FROM users WHERE email = ?', email);
    const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok) throw new AppError(401, 'bad_credentials', 'E-mail or password is wrong.');
    return this.toUser(row);
  }

  createSession(userId: string, userAgent: string): { token: string; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.auth.sessionDays * 86_400_000);
    this.db.run(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
      hashToken(token),
      userId,
      now.toISOString(),
      expiresAt.toISOString(),
      now.toISOString(),
      userAgent.slice(0, 200),
    );
    return { token, expiresAt };
  }

  userForToken(token: string | undefined): User | null {
    if (!token) return null;
    const row = this.db.get<UserRow & { expires_at: string }>(
      'SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
      hashToken(token),
    );
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.destroySession(token);
      return null;
    }
    return this.toUser(row);
  }

  destroySession(token: string | undefined): void {
    if (token) this.db.run('DELETE FROM sessions WHERE token_hash = ?', hashToken(token));
  }

  purgeExpired(): number {
    return this.db.run('DELETE FROM sessions WHERE expires_at <= ?', new Date().toISOString()).changes;
  }

  /** Changing the password signs out every other device. */
  async changePassword(userId: string, current: unknown, next: unknown, keepToken: string | undefined): Promise<void> {
    const row = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
    if (!row || typeof current !== 'string' || !(await verifyPassword(current, row.password_hash))) {
      throw new AppError(401, 'bad_credentials', 'Your current password is wrong.');
    }
    const { password } = this.validateCredentials(row.email, next);
    const hash = await hashPassword(password);
    this.db.transaction(() => {
      this.db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, userId);
      this.db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', userId, keepToken ? hashToken(keepToken) : '');
    });
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const key = part.slice(0, i).trim();
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

export function sessionCookie(token: string, expires: Date, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure ? '; Secure' : ''}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}
