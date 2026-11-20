import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** One AI service (speech-to-text or translation) reached through an OpenAI-compatible HTTP API. */
export interface AiService {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface AiSettings {
  transcription: AiService;
  translation: AiService;
  /** sent to OpenRouter as HTTP-Referer / X-Title (optional attribution) */
  appUrl: string;
  appName: string;
  /** audio longer than this is split into pieces and sent one piece at a time */
  transcriptionChunkSeconds: number;
}

export type PaymentsMode = 'demo' | 'stripe' | 'off';

/** Credits, plans and payments. Costs are in whole credits. */
export interface BillingConfig {
  /** demo = fake checkout (no real money), stripe = real Stripe Checkout, off = purchases disabled */
  paymentsMode: PaymentsMode;
  /** why the requested mode could not be used (shown to the owner), if it could not */
  paymentsNote: string;
  stripe: { secretKey: string; webhookSecret: string; apiBase: string };
  /** public https address of this site (used for payment redirects) */
  publicUrl: string;
  currency: string;
  /** credits every account gets at the start of each calendar month (UTC); unused ones expire */
  freeMonthlyCredits: number;
  /** a notification is sent when the balance drops to this many credits or fewer */
  lowCreditThreshold: number;
  costs: {
    /** credits per started minute of video for speech-to-text */
    transcribePerMinute: number;
    /** one credit buys this many started minutes of translation */
    translateMinutesPerCredit: number;
    /** one credit buys this many started minutes of burned-in video rendering */
    renderMinutesPerCredit: number;
  };
}

export interface AuthConfig {
  sessionDays: number;
  /** 'auto' = Secure cookie when the request arrived over HTTPS */
  cookieSecure: 'auto' | boolean;
  /** sign-in / sign-up attempts allowed per client per 15 minutes */
  attemptsMax: number;
}

export interface Config {
  host: string;
  port: number;
  /** where projects, renders and temp files live */
  dataDir: string;
  /** SQLite file for accounts, credits and payments */
  dbPath: string;
  clientDir: string;
  sharedDir: string;
  maxUploadBytes: number;
  /** longest video accepted, in seconds */
  maxDurationSeconds: number;
  /** how long one upload request may take */
  uploadTimeoutMs: number;
  /** origins allowed to call the API from another website (empty = same-origin only) */
  allowedOrigins: string[];
  /** trust X-Forwarded-For (only enable behind your own reverse proxy) */
  trustProxy: boolean;
  rateLimit: { enabled: boolean; windowMs: number; max: number; heavyMax: number };
  ai: AiSettings;
  auth: AuthConfig;
  billing: BillingConfig;
  ffmpegPath: string;
  ffprobePath: string;
  /** optional folder with extra .ttf/.otf fonts for burned-in subtitles */
  fontsDir: string;
  renderRetentionHours: number;
  maxConcurrentRenders: number;
  logRequests: boolean;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

function num(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * AI settings. Everything defaults to OpenRouter, so normally only OPENROUTER_API_KEY is needed.
 * TRANSCRIPTION_API_KEY / TRANSCRIPTION_BASE_URL are optional: they let speech-to-text use a
 * different OpenAI-compatible service than translation.
 */
function loadAiSettings(env: NodeJS.ProcessEnv): AiSettings {
  const openRouterKey = env.OPENROUTER_API_KEY?.trim() ?? '';
  const openRouterUrl = trimSlash(env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1');
  return {
    transcription: {
      apiKey: env.TRANSCRIPTION_API_KEY?.trim() || openRouterKey,
      baseUrl: trimSlash(env.TRANSCRIPTION_BASE_URL?.trim() || openRouterUrl),
      model: env.TRANSCRIPTION_MODEL?.trim() || 'openai/whisper-large-v3-turbo',
    },
    translation: {
      apiKey: openRouterKey,
      baseUrl: openRouterUrl,
      // "openrouter/free" is OpenRouter's router that only uses free models.
      model: env.TRANSLATION_MODEL?.trim() || 'openrouter/free',
    },
    appUrl: env.OPENROUTER_APP_URL?.trim() ?? '',
    appName: env.OPENROUTER_APP_NAME?.trim() || 'Subly AI',
    transcriptionChunkSeconds: Math.round(num(env.TRANSCRIPTION_CHUNK_MINUTES, 10, 1, 60) * 60),
  };
}

function loadBilling(env: NodeJS.ProcessEnv): BillingConfig {
  const secretKey = env.STRIPE_SECRET_KEY?.trim() ?? '';
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() ?? '';
  const publicUrl = trimSlash(env.PUBLIC_URL?.trim() ?? '');
  const requested = env.PAYMENTS_MODE?.trim().toLowerCase();

  let mode: PaymentsMode = requested === 'stripe' || requested === 'demo' || requested === 'off' ? requested : secretKey ? 'stripe' : 'demo';
  let note = '';
  if (mode === 'stripe') {
    const missing = [!secretKey && 'STRIPE_SECRET_KEY', !webhookSecret && 'STRIPE_WEBHOOK_SECRET', !publicUrl && 'PUBLIC_URL'].filter(Boolean);
    if (missing.length > 0) {
      note = `Real payments are switched off because these settings are missing: ${missing.join(', ')}.`;
      mode = 'off';
    }
  }
  return {
    paymentsMode: mode,
    paymentsNote: note,
    stripe: { secretKey, webhookSecret, apiBase: trimSlash(env.STRIPE_API_BASE?.trim() || 'https://api.stripe.com') },
    publicUrl,
    currency: (env.PAYMENT_CURRENCY?.trim() || 'usd').toLowerCase(),
    freeMonthlyCredits: Math.round(num(env.FREE_MONTHLY_CREDITS, 30, 0, 100_000)),
    lowCreditThreshold: Math.round(num(env.LOW_CREDIT_THRESHOLD, 5, 0, 100_000)),
    costs: {
      transcribePerMinute: Math.round(num(env.CREDITS_TRANSCRIBE_PER_MINUTE, 1, 1, 1000)),
      translateMinutesPerCredit: Math.round(num(env.CREDITS_TRANSLATE_MINUTES_PER_CREDIT, 2, 1, 1000)),
      renderMinutesPerCredit: Math.round(num(env.CREDITS_RENDER_MINUTES_PER_CREDIT, 5, 1, 1000)),
    },
  };
}

/** Read settings from environment variables (see .env.example). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const dataDir = path.resolve(env.DATA_DIR?.trim() || path.join(root, 'data'));
  const config: Config = {
    host: env.HOST?.trim() || '127.0.0.1',
    port: num(env.PORT, 3000, 0, 65535),
    dataDir,
    dbPath: path.join(dataDir, 'subly.db'),
    clientDir: path.join(root, 'client', 'dist'),
    sharedDir: path.join(root, 'shared'),
    maxUploadBytes: Math.round(num(env.MAX_UPLOAD_MB, 500, 1, 10240) * 1024 * 1024),
    maxDurationSeconds: Math.round(num(env.MAX_VIDEO_MINUTES, 90, 1, 1440) * 60),
    uploadTimeoutMs: Math.round(num(env.UPLOAD_TIMEOUT_MINUTES, 30, 1, 240) * 60_000),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim().replace(/\/$/, ''))
      .filter(Boolean),
    trustProxy: bool(env.TRUST_PROXY, false),
    rateLimit: {
      enabled: bool(env.RATE_LIMIT_ENABLED, true),
      windowMs: 15 * 60_000,
      max: num(env.RATE_LIMIT_MAX, 600, 1, 100_000),
      heavyMax: num(env.RATE_LIMIT_HEAVY_MAX, 40, 1, 10_000),
    },
    ai: loadAiSettings(env),
    auth: {
      sessionDays: Math.round(num(env.SESSION_DAYS, 30, 1, 365)),
      cookieSecure: env.COOKIE_SECURE === undefined || env.COOKIE_SECURE.trim() === '' || env.COOKIE_SECURE.trim() === 'auto' ? 'auto' : bool(env.COOKIE_SECURE, false),
      attemptsMax: Math.round(num(env.AUTH_ATTEMPTS_MAX, 30, 1, 10_000)),
    },
    billing: loadBilling(env),
    ffmpegPath: env.FFMPEG_PATH?.trim() || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH?.trim() || 'ffprobe',
    fontsDir: env.FONTS_DIR?.trim() ?? '',
    renderRetentionHours: num(env.RENDER_RETENTION_HOURS, 24, 1, 24 * 90),
    maxConcurrentRenders: Math.round(num(env.MAX_CONCURRENT_RENDERS, 1, 1, 16)),
    logRequests: bool(env.LOG_REQUESTS, true),
  };
  const merged = { ...config, ...overrides };
  // keep the database next to the data folder even when a test overrides only dataDir
  if (overrides.dataDir && !overrides.dbPath) merged.dbPath = path.join(overrides.dataDir, 'subly.db');
  return merged;
}
