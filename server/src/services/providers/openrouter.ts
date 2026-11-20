import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AiService, Config } from '../../config.ts';
import { findLanguage } from '../../config/languages.ts';
import { probe, runFfmpeg } from '../ffmpeg.ts';
import type { RawSegment } from '../segments.ts';
import { ProviderError } from './types.ts';
import type { TranscriptionProvider, TranscriptionResult, TranslationProvider } from './types.ts';

/**
 * OpenRouter providers (https://openrouter.ai).
 *
 *  - Translation: chat completions. The default model is "openrouter/free", OpenRouter's router
 *    that only uses FREE models. Free models are rate limited and their quality varies.
 *  - Speech-to-text: POST /audio/transcriptions. OpenRouter has NO free speech-to-text models:
 *    it is billed per audio second from your OpenRouter credits (the default model is very cheap).
 *
 * The code speaks the OpenAI-compatible API, so TRANSCRIPTION_BASE_URL can point to another
 * compatible service. The automated tests run these classes against a local mock server
 * (tests/api/providers.test.ts), not against the live OpenRouter service.
 */

interface Settings {
  service: AiService;
  appUrl: string;
  appName: string;
  /** base delay between retries; tests lower this */
  retryDelayMs?: number;
}

export function isOpenRouter(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

function serviceLabel(service: AiService): string {
  if (isOpenRouter(service.baseUrl)) return `OpenRouter (${service.model})`;
  try {
    return `${new URL(service.baseUrl).hostname} (${service.model})`;
  } catch {
    return service.model;
  }
}

function authHeaders(settings: Settings): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${settings.service.apiKey}` };
  // Optional OpenRouter attribution headers. Never sent to other services.
  if (isOpenRouter(settings.service.baseUrl)) {
    if (settings.appUrl) headers['HTTP-Referer'] = settings.appUrl;
    if (settings.appName) headers['X-Title'] = settings.appName;
  }
  return headers;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new ProviderError('timeout', 'The operation was canceled.'));
      },
      { once: true },
    );
  });
}

const KEY_HELP = 'Check OPENROUTER_API_KEY in the server settings (.env).';

/** Map an error status (+ the provider's message) to a safe, helpful error. */
function errorFor(status: number, detail: string, apiCode: string): ProviderError {
  if (status === 401) return new ProviderError('auth', `The AI service rejected the API key. ${KEY_HELP}`);
  if (status === 402 || /insufficient_quota|billing/i.test(apiCode)) {
    return new ProviderError(
      'quota',
      'The AI service says this account does not have enough credit for the request. Speech-to-text is not free on OpenRouter: add a small amount of credit at openrouter.ai, then try again.',
    );
  }
  if (status === 404) {
    return new ProviderError(
      'rejected',
      'The AI service could not use this model (it may be renamed, removed, or have no available provider). Check TRANSCRIPTION_MODEL / TRANSLATION_MODEL in .env.',
    );
  }
  if (status === 429) {
    return new ProviderError('rate_limited', 'The AI service is busy or its (free) rate limit was reached. Wait a minute and try again.');
  }
  if (status === 408 || status >= 500) {
    return new ProviderError('unavailable', 'The AI service is temporarily unavailable. Try again shortly.');
  }
  return new ProviderError('rejected', `The AI service rejected the request${detail ? `: ${detail}` : '.'}`);
}

async function toProviderError(response: Response): Promise<ProviderError> {
  let detail = '';
  let apiCode = '';
  try {
    const body = (await response.json()) as { error?: { message?: string; code?: string | number; type?: string } };
    detail = String(body.error?.message ?? '').slice(0, 200);
    apiCode = String(body.error?.type ?? '');
  } catch {
    /* body was not JSON */
  }
  return errorFor(response.status, detail, apiCode);
}

/** fetch with timeout + retry on 408/429/5xx (honouring Retry-After). */
async function request(settings: Settings, url: string, init: () => RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const attempts = 3;
  const baseDelay = settings.retryDelayMs ?? 1000;
  let lastError: ProviderError | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(url, { ...init(), signal: combined });
    } catch {
      if (signal?.aborted) throw new ProviderError('timeout', 'The operation was canceled.');
      lastError = timeout.aborted
        ? new ProviderError('timeout', 'The AI service took too long to respond.')
        : new ProviderError('unavailable', "Could not reach the AI service. Check the server's internet connection.");
      if (attempt < attempts) {
        await sleep(baseDelay * attempt, signal);
        continue;
      }
      throw lastError;
    }

    if (response.ok) return response;

    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    lastError = await toProviderError(response);
    if (!retryable || lastError.code === 'quota' || attempt === attempts) throw lastError;

    const retryAfter = Number(response.headers.get('retry-after'));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 20_000) : baseDelay * attempt;
    await sleep(delay, signal);
  }
  throw lastError ?? new ProviderError('unavailable', 'The AI service request failed.');
}

// ---------------------------------------------------------------------------
// Speech to text
// ---------------------------------------------------------------------------

interface TranscriptionExtra {
  retryDelayMs?: number;
  /** override the chunk length (tests) */
  chunkSeconds?: number;
}

export class OpenRouterTranscription implements TranscriptionProvider {
  readonly id = 'openrouter';
  readonly name: string;
  /** Audio is sent in pieces, so this only guards against absurdly large files (32 kbps MP3 is ~4 KB/s). */
  readonly maxAudioBytes = 64 * 1024 * 1024;
  readonly maxAudioSeconds = 120 * 60;
  readonly note: string;
  private config: Config;
  private settings: Settings;
  private chunkSeconds: number;

  constructor(config: Config, extra: TranscriptionExtra = {}) {
    this.config = config;
    this.settings = { service: config.ai.transcription, appUrl: config.ai.appUrl, appName: config.ai.appName, retryDelayMs: extra.retryDelayMs };
    this.chunkSeconds = extra.chunkSeconds ?? config.ai.transcriptionChunkSeconds;
    this.name = serviceLabel(config.ai.transcription);
    this.note = isOpenRouter(config.ai.transcription.baseUrl)
      ? 'Speech-to-text is not free on OpenRouter: it is billed per audio minute from your OpenRouter credits. Videos up to 2 hours.'
      : 'Billing depends on the configured speech-to-text service. Videos up to 2 hours.';
  }

  isConfigured(): boolean {
    return this.settings.service.apiKey !== '';
  }

  async transcribe(input: { audioPath: string; language?: string; signal?: AbortSignal }): Promise<TranscriptionResult> {
    if (!this.isConfigured()) throw new ProviderError('not_configured', 'No AI API key is configured.');

    const { duration } = await probe(this.config, input.audioPath);
    // Short audio: one request, no splitting.
    if (!(duration > this.chunkSeconds * 1.05)) {
      return this.sendChunk(input.audioPath, input.language, 0, input.signal);
    }

    // Long audio: the provider limits how long one request may run, so send it in pieces.
    const dir = await mkdtemp(path.join(path.dirname(input.audioPath), 'chunks-'));
    try {
      await runFfmpeg(
        this.config,
        ['-y', '-i', input.audioPath, '-f', 'segment', '-segment_time', String(this.chunkSeconds), '-c', 'copy', '-reset_timestamps', '1', path.join(dir, 'part-%03d.mp3')],
        { signal: input.signal },
      );
      const parts = (await readdir(dir)).filter((name) => name.endsWith('.mp3')).sort();

      const segments: RawSegment[] = [];
      let language = input.language;
      let detected: string | undefined;
      for (let index = 0; index < parts.length; index += 1) {
        const result = await this.sendChunk(path.join(dir, parts[index] as string), language, index * this.chunkSeconds, input.signal);
        segments.push(...result.segments);
        if (!detected && result.language) {
          detected = result.language;
          // Auto-detect: reuse the first piece's language so later pieces stay consistent.
          language ??= findLanguage(result.language)?.code;
        }
      }
      return { language: detected, segments };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Send one audio file. `offset` (seconds) is added to every timestamp. */
  private async sendChunk(file: string, language: string | undefined, offset: number, signal?: AbortSignal): Promise<TranscriptionResult> {
    const audio = await readFile(file);
    const service = this.settings.service;

    const response = await request(
      this.settings,
      `${service.baseUrl}/audio/transcriptions`,
      () => {
        const form = new FormData();
        form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'audio.mp3');
        form.append('model', service.model);
        form.append('response_format', 'verbose_json');
        form.append('timestamp_granularities[]', 'segment');
        if (language) form.append('language', language);
        return { method: 'POST', headers: authHeaders(this.settings), body: form };
      },
      120_000,
      signal,
    );

    let body: { language?: unknown; duration?: unknown; text?: unknown; segments?: unknown; error?: { message?: unknown; code?: unknown } };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new ProviderError('bad_response', 'The AI service returned an unreadable response.');
    }
    if (body.error) throw errorFor(Number(body.error.code) || 502, String(body.error.message ?? '').slice(0, 200), '');

    const segments: RawSegment[] = Array.isArray(body.segments)
      ? body.segments
          .map((s: { start?: unknown; end?: unknown; text?: unknown }) => ({
            start: Number(s?.start) + offset,
            end: Number(s?.end) + offset,
            text: String(s?.text ?? ''),
          }))
          .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
      : [];

    // Some models only return plain text: keep it as one editable segment.
    if (segments.length === 0 && typeof body.text === 'string' && body.text.trim() !== '') {
      const length = Number(body.duration);
      segments.push({ start: offset, end: offset + (Number.isFinite(length) && length > 0 ? length : 5), text: body.text });
    }

    return { language: typeof body.language === 'string' ? body.language : undefined, segments };
  }
}

// ---------------------------------------------------------------------------
// Translation (chat completions, JSON in / JSON out)
// ---------------------------------------------------------------------------

/**
 * Read the model's answer. Free models often wrap JSON in ```code fences``` or add a sentence
 * around it, so this is deliberately forgiving. Returns null unless there is exactly one string
 * per input line.
 */
export function parseTranslations(content: string, expected: number): string[] | null {
  const text = content.replace(/```(?:json)?/gi, '').trim();
  const candidates = [text];
  const firstBrace = text.search(/[{[]/);
  const lastBrace = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const list = Array.isArray(parsed) ? parsed : (parsed as { translations?: unknown } | null)?.translations;
      if (Array.isArray(list) && list.length === expected && list.every((item) => typeof item === 'string')) {
        return (list as string[]).map((item) => item.trim());
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** The message content can be a string or a list of text parts. */
function contentToText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content.map((part: { text?: unknown }) => (typeof part?.text === 'string' ? part.text : '')).join('');
    return text === '' ? null : text;
  }
  return null;
}

export class OpenRouterTranslation implements TranslationProvider {
  readonly id = 'openrouter';
  readonly name: string;
  readonly note: string;
  private settings: Settings;

  constructor(config: Config, extra: { retryDelayMs?: number } = {}) {
    this.settings = { service: config.ai.translation, appUrl: config.ai.appUrl, appName: config.ai.appName, retryDelayMs: extra.retryDelayMs };
    this.name = serviceLabel(config.ai.translation);
    const free = config.ai.translation.model === 'openrouter/free' || config.ai.translation.model.endsWith(':free');
    this.note = free
      ? 'Uses a free OpenRouter model. Free models are rate limited and quality varies by language (lower for Marathi, Telugu and other smaller languages). Always review the result.'
      : 'Machine translation by the configured model; it may use paid credits. Quality varies by language: review the result.';
  }

  isConfigured(): boolean {
    return this.settings.service.apiKey !== '';
  }

  async translate(input: { lines: string[]; sourceLanguage?: string; targetLanguage: string; signal?: AbortSignal }): Promise<string[]> {
    if (!this.isConfigured()) throw new ProviderError('not_configured', 'No AI API key is configured.');
    if (input.lines.length === 0) return [];

    // Free models sometimes merge or drop a line or break the JSON; try twice before giving up.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await this.attempt(input);
      if (result) return result;
    }
    throw new ProviderError('bad_response', 'The AI model returned a translation in the wrong format or with the wrong number of lines. Try again, or choose another model in .env.');
  }

  private async attempt(input: { lines: string[]; sourceLanguage?: string; targetLanguage: string; signal?: AbortSignal }): Promise<string[] | null> {
    const system =
      `You are a professional subtitle translator. Translate every line into ${input.targetLanguage}. ` +
      'Keep the meaning, tone and brevity suitable for on-screen subtitles. Do not merge, split, add or drop lines. ' +
      'Keep names and numbers. Reply ONLY with JSON of the form {"translations": ["..."]} containing exactly one string ' +
      'per input line, in the same order. No explanations and no code fences.';
    const user = JSON.stringify({
      source_language: input.sourceLanguage ?? 'auto-detect',
      target_language: input.targetLanguage,
      lines: input.lines,
    });
    const service = this.settings.service;

    const response = await request(
      this.settings,
      `${service.baseUrl}/chat/completions`,
      () => ({
        method: 'POST',
        headers: { ...authHeaders(this.settings), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: service.model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      }),
      90_000,
      input.signal,
    );

    let body: { choices?: Array<{ message?: { content?: unknown } }>; error?: { message?: unknown; code?: unknown } };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new ProviderError('bad_response', 'The AI service returned an unreadable response.');
    }
    // OpenRouter can answer 200 with an error object when the upstream model failed.
    if (body.error) throw errorFor(Number(body.error.code) || 502, String(body.error.message ?? '').slice(0, 200), '');

    const content = contentToText(body.choices?.[0]?.message?.content);
    if (content === null) return null;
    return parseTranslations(content, input.lines.length);
  }
}
