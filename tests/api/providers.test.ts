// Tests for the OpenRouter providers against a LOCAL MOCK of the OpenRouter API.
// They prove our request format, parsing, retries and error mapping. They do not prove that a real
// OpenRouter key works: test that yourself with a short clip (see README).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { loadConfig } from '../../server/src/config.ts';
import { isOpenRouter, OpenRouterTranscription, OpenRouterTranslation, parseTranslations } from '../../server/src/services/providers/openrouter.ts';
import { ProviderError } from '../../server/src/services/providers/types.ts';

interface Recorded {
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}
interface Reply {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}

let tmp: string;
let audio10: string;
let audio25: string;
let baseUrl: string;
let requests: Recorded[] = [];
let replies: Array<(req: Recorded) => Reply> = [];
let close: () => Promise<void>;

function makeAudio(file: string, seconds: number): string {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', file], { stdio: 'pipe' });
  return file;
}

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'subly-providers-'));
  audio10 = makeAudio(path.join(tmp, 'short.mp3'), 4);
  audio25 = makeAudio(path.join(tmp, 'long.mp3'), 25);

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const recorded: Recorded = { url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('latin1') };
      requests.push(recorded);
      const next = replies.shift();
      const reply = next ? next(recorded) : { status: 500, json: { error: { message: 'no reply queued' } } };
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
      res.end(JSON.stringify(reply.json ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
});

after(async () => {
  await close();
  await rm(tmp, { recursive: true, force: true });
});

function reset(...queue: Array<(req: Recorded) => Reply>): void {
  requests = [];
  replies = queue;
}

function configFor(env: Record<string, string> = {}) {
  return loadConfig({ OPENROUTER_API_KEY: 'test-key', OPENROUTER_BASE_URL: baseUrl, ...env }, {});
}

async function rejects(promise: Promise<unknown>, code: string, messagePattern?: RegExp): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ProviderError, `expected ProviderError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (messagePattern) assert.match(error.message, messagePattern);
    return error;
  }
  throw new assert.AssertionError({ message: `expected a ${code} error but the call succeeded` });
}

// ------------------------------------------------------------------ configuration
test('defaults point at OpenRouter: Whisper turbo for speech, the free router for translation', () => {
  const config = loadConfig({ OPENROUTER_API_KEY: 'k' }, {});
  assert.equal(config.ai.transcription.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(config.ai.transcription.model, 'openai/whisper-large-v3-turbo');
  assert.equal(config.ai.translation.model, 'openrouter/free');
  assert.equal(config.ai.transcription.apiKey, 'k');
  assert.equal(config.ai.translation.apiKey, 'k');
});

test('without a key both providers report not configured and refuse to run', async () => {
  const config = loadConfig({}, {});
  const stt = new OpenRouterTranscription(config);
  const mt = new OpenRouterTranslation(config);
  assert.equal(stt.isConfigured(), false);
  assert.equal(mt.isConfigured(), false);
  await rejects(stt.transcribe({ audioPath: audio10 }), 'not_configured');
  await rejects(mt.translate({ lines: ['hi'], targetLanguage: 'French' }), 'not_configured');
});

test('TRANSCRIPTION_* settings can point speech-to-text at another service', () => {
  const config = loadConfig({ OPENROUTER_API_KEY: 'a', TRANSCRIPTION_API_KEY: 'b', TRANSCRIPTION_BASE_URL: 'https://example.com/v1/', TRANSCRIPTION_MODEL: 'm' }, {});
  assert.equal(config.ai.transcription.apiKey, 'b');
  assert.equal(config.ai.transcription.baseUrl, 'https://example.com/v1');
  assert.equal(config.ai.translation.apiKey, 'a');
});

test('only real OpenRouter hosts count as OpenRouter', () => {
  assert.equal(isOpenRouter('https://openrouter.ai/api/v1'), true);
  assert.equal(isOpenRouter('https://eu.openrouter.ai/api/v1'), true);
  assert.equal(isOpenRouter('https://openrouter.ai.evil.example/v1'), false);
  assert.equal(isOpenRouter('http://127.0.0.1:1/v1'), false);
  assert.equal(isOpenRouter('not a url'), false);
});

test('the notes tell the truth: speech-to-text is paid, translation uses a free model', () => {
  const config = loadConfig({ OPENROUTER_API_KEY: 'k' }, {});
  assert.match(new OpenRouterTranscription(config).note, /not free/i);
  assert.match(new OpenRouterTranslation(config).note, /free/i);
  const paid = loadConfig({ OPENROUTER_API_KEY: 'k', TRANSLATION_MODEL: 'openai/gpt-4o-mini' }, {});
  assert.match(new OpenRouterTranslation(paid).note, /paid credits/i);
});

// ------------------------------------------------------------------ speech to text
test('transcription: multipart request, auth header, model, language and parsed segments', async () => {
  reset(() => ({ json: { language: 'english', duration: 4, text: 'Hello there', segments: [{ id: 0, start: 0.5, end: 2, text: ' Hello there ' }] } }));
  const provider = new OpenRouterTranscription(configFor(), { retryDelayMs: 1 });
  const result = await provider.transcribe({ audioPath: audio10, language: 'en' });

  assert.equal(requests.length, 1);
  const [req] = requests as [Recorded];
  assert.equal(req.url, '/api/v1/audio/transcriptions');
  assert.equal(req.headers.authorization, 'Bearer test-key');
  assert.match(String(req.headers['content-type']), /^multipart\/form-data/);
  assert.match(req.body, /name="model"\r\n\r\nopenai\/whisper-large-v3-turbo/);
  assert.match(req.body, /name="response_format"\r\n\r\nverbose_json/);
  assert.match(req.body, /name="language"\r\n\r\nen/);
  assert.equal(req.headers['x-title'], undefined, 'attribution headers are only sent to openrouter.ai');
  assert.equal(result.language, 'english');
  assert.deepEqual(result.segments, [{ start: 0.5, end: 2, text: ' Hello there ' }]);
});

test('transcription: models that return only text still give one editable segment', async () => {
  reset(() => ({ json: { text: 'Only plain text.', duration: 3 } }));
  const result = await new OpenRouterTranscription(configFor()).transcribe({ audioPath: audio10 });
  assert.deepEqual(result.segments, [{ start: 0, end: 3, text: 'Only plain text.' }]);
});

test('transcription: long audio is split, timestamps are shifted, detected language is reused', async () => {
  const piece = (text: string) => () => ({ json: { language: 'english', text, segments: [{ start: 1, end: 2, text }] } });
  reset(piece('one'), piece('two'), piece('three'));
  const provider = new OpenRouterTranscription(configFor(), { retryDelayMs: 1, chunkSeconds: 10 });
  const result = await provider.transcribe({ audioPath: audio25 }); // 25 s -> pieces of 10 s

  assert.equal(requests.length, 3, 'three requests for 25 s with 10 s pieces');
  assert.deepEqual(
    result.segments.map((s) => [s.text, s.start, s.end]),
    [['one', 1, 2], ['two', 11, 12], ['three', 21, 22]],
  );
  assert.equal(result.language, 'english');
  assert.doesNotMatch((requests[0] as Recorded).body, /name="language"/, 'first piece auto-detects');
  assert.match((requests[1] as Recorded).body, /name="language"\r\n\r\nen/, 'later pieces reuse the detected language');
  assert.match((requests[2] as Recorded).body, /name="language"\r\n\r\nen/);
});

test('transcription errors: bad key, no credit (not retried), unknown model, rate limit (retried)', async () => {
  const provider = new OpenRouterTranscription(configFor(), { retryDelayMs: 1 });

  reset(() => ({ status: 401, json: { error: { message: 'No auth credentials found' } } }));
  await rejects(provider.transcribe({ audioPath: audio10 }), 'auth', /OPENROUTER_API_KEY/);
  assert.equal(requests.length, 1);

  reset(() => ({ status: 402, json: { error: { message: 'Insufficient credits' } } }));
  await rejects(provider.transcribe({ audioPath: audio10 }), 'quota', /not free on OpenRouter/);
  assert.equal(requests.length, 1, 'a missing credit is not retried');

  reset(() => ({ status: 404, json: { error: { message: 'No endpoints found' } } }));
  await rejects(provider.transcribe({ audioPath: audio10 }), 'rejected', /TRANSCRIPTION_MODEL/);

  const busy = () => ({ status: 429, json: { error: { message: 'slow down' } }, headers: { 'Retry-After': '0' } });
  reset(busy, busy, busy);
  await rejects(provider.transcribe({ audioPath: audio10 }), 'rate_limited');
  assert.equal(requests.length, 3, 'rate limits are retried up to 3 times');

  reset(busy, () => ({ json: { text: 'ok', segments: [{ start: 0, end: 1, text: 'ok' }] } }));
  const recovered = await provider.transcribe({ audioPath: audio10 });
  assert.equal(recovered.segments[0]?.text, 'ok', 'recovers after one rate-limit reply');
});

test('transcription: an error object inside a 200 reply becomes a clear error', async () => {
  reset(() => ({ status: 200, json: { error: { code: 429, message: 'upstream busy' } } }));
  await rejects(new OpenRouterTranscription(configFor()).transcribe({ audioPath: audio10 }), 'rate_limited');
});

// ------------------------------------------------------------------ translation
test('translation: chat request without response_format, free router model, parsed result', async () => {
  reset(() => ({ json: { choices: [{ message: { content: '{"translations": [" Bonjour ", "Salut"]}' } }] } }));
  const provider = new OpenRouterTranslation(configFor(), { retryDelayMs: 1 });
  const out = await provider.translate({ lines: ['Hello', 'Hi'], sourceLanguage: 'English', targetLanguage: 'French' });
  assert.deepEqual(out, ['Bonjour', 'Salut']);

  const req = requests[0] as Recorded;
  assert.equal(req.url, '/api/v1/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer test-key');
  const sent = JSON.parse(req.body) as { model: string; response_format?: unknown; messages: Array<{ role: string; content: string }> };
  assert.equal(sent.model, 'openrouter/free');
  assert.equal(sent.response_format, undefined, 'free models do not all support JSON mode');
  assert.deepEqual(JSON.parse(sent.messages[1]?.content ?? '{}').lines, ['Hello', 'Hi']);
});

test('translation: copes with code fences, chatty replies and content given as parts', async () => {
  const provider = new OpenRouterTranslation(configFor(), { retryDelayMs: 1 });

  reset(() => ({ json: { choices: [{ message: { content: 'Sure!\n```json\n{"translations": ["a", "b"]}\n```\nHope this helps.' } }] } }));
  assert.deepEqual(await provider.translate({ lines: ['x', 'y'], targetLanguage: 'Hindi' }), ['a', 'b']);

  reset(() => ({ json: { choices: [{ message: { content: [{ type: 'text', text: '["c", "d"]' }] } }] } }));
  assert.deepEqual(await provider.translate({ lines: ['x', 'y'], targetLanguage: 'Hindi' }), ['c', 'd']);
});

test('translation: a wrong line count is retried once, then reported clearly', async () => {
  const provider = new OpenRouterTranslation(configFor(), { retryDelayMs: 1 });
  const wrong = () => ({ json: { choices: [{ message: { content: '{"translations": ["only one"]}' } }] } });
  const right = () => ({ json: { choices: [{ message: { content: '{"translations": ["one", "two"]}' } }] } });

  reset(wrong, right);
  assert.deepEqual(await provider.translate({ lines: ['a', 'b'], targetLanguage: 'Spanish' }), ['one', 'two']);
  assert.equal(requests.length, 2);

  reset(wrong, wrong);
  await rejects(provider.translate({ lines: ['a', 'b'], targetLanguage: 'Spanish' }), 'bad_response', /wrong format|wrong number/);
});

test('translation errors: free-model rate limit and upstream errors inside a 200 reply', async () => {
  const provider = new OpenRouterTranslation(configFor(), { retryDelayMs: 1 });
  const busy = () => ({ status: 429, json: { error: { message: 'free-models-per-day' } }, headers: { 'Retry-After': '0' } });
  reset(busy, busy, busy);
  await rejects(provider.translate({ lines: ['a'], targetLanguage: 'French' }), 'rate_limited', /free\) rate limit/);

  reset(() => ({ status: 200, json: { error: { code: 502, message: 'Provider returned error' } } }));
  await rejects(provider.translate({ lines: ['a'], targetLanguage: 'French' }), 'unavailable');
});

test('translation: an empty list needs no request', async () => {
  reset();
  assert.deepEqual(await new OpenRouterTranslation(configFor()).translate({ lines: [], targetLanguage: 'French' }), []);
  assert.equal(requests.length, 0);
});

// ------------------------------------------------------------------ parseTranslations
test('parseTranslations accepts only exactly one string per line', () => {
  assert.deepEqual(parseTranslations('{"translations":["a","b"]}', 2), ['a', 'b']);
  assert.deepEqual(parseTranslations('["a","b"]', 2), ['a', 'b']);
  assert.deepEqual(parseTranslations('```\n["a"]\n```', 1), ['a']);
  assert.equal(parseTranslations('{"translations":["a"]}', 2), null, 'too few');
  assert.equal(parseTranslations('{"translations":["a","b","c"]}', 2), null, 'too many');
  assert.equal(parseTranslations('{"translations":["a",2]}', 2), null, 'not strings');
  assert.equal(parseTranslations('no json here', 1), null);
  assert.equal(parseTranslations('', 1), null);
});
