import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/src/app.ts';
import type { App } from '../server/src/app.ts';
import { loadConfig } from '../server/src/config.ts';
import type { Config } from '../server/src/config.ts';
import { ProviderError } from '../server/src/services/providers/types.ts';
import type { Providers } from '../server/src/services/providers/types.ts';

/** A tiny real video (4 s, 320x240, with audio) made by FFmpeg. Returns the file path. */
export function makeTestVideo(file: string, seconds = 4, extra: string[] = []): string {
  execFileSync(
    'ffmpeg',
    ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=15:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', ...extra, file],
    { stdio: 'pipe' },
  );
  return file;
}

export type FakeMode = 'ok' | 'rate_limited' | 'silent';

/** Providers that never call the network. `mode` makes them succeed or fail on purpose. */
export function fakeProviders(mode: FakeMode = 'ok'): Providers {
  return {
    transcription: {
      id: 'fake',
      name: 'Fake transcriber',
      note: 'test double',
      maxAudioSeconds: 3600,
      maxAudioBytes: 100 * 1024 * 1024,
      isConfigured: () => true,
      async transcribe() {
        if (mode === 'rate_limited') throw new ProviderError('rate_limited', 'The AI service is busy (rate limit). Wait a minute and try again.');
        if (mode === 'silent') return { language: 'english', segments: [] };
        return {
          language: 'english',
          segments: [
            { start: 0.2, end: 1.8, text: 'Welcome to my video.' },
            { start: 2, end: 3.6, text: "Let's start learning!" },
          ],
        };
      },
    },
    translation: {
      id: 'fake',
      name: 'Fake translator',
      note: 'test double',
      isConfigured: () => true,
      async translate({ lines, targetLanguage }) {
        return lines.map((line) => `[${targetLanguage}] ${line}`);
      },
    },
  };
}

export interface TestServer {
  app: App;
  base: string;
  dataDir: string;
  config: Config;
  close: () => Promise<void>;
}

export async function startServer(options: { providers?: Providers; config?: Partial<Config>; dataDir?: string; keepData?: boolean } = {}): Promise<TestServer> {
  const dataDir = options.dataDir ?? (await mkdtemp(path.join(os.tmpdir(), 'subly-test-')));
  const config = loadConfig({}, {
    port: 0,
    host: '127.0.0.1',
    dataDir,
    logRequests: false,
    rateLimit: { enabled: false, windowMs: 60_000, max: 1000, heavyMax: 1000 },
    ...options.config,
  });
  const app = await createApp(config, options.providers ? { providers: options.providers } : {});
  const port = await app.listen();
  return {
    app,
    config,
    dataDir,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await app.close();
      if (!options.keepData) await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** `token` is the SESSION token of the account that owns the project (sent as the session cookie). */
export interface Created { id: string; token: string; userId: string }

let userCounter = 0;

export function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Cookie: `subly_session=${token}`, 'X-Requested-With': 'subly' } : { 'X-Requested-With': 'subly' };
}

export async function api(base: string, method: string, url: string, options: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...authHeaders(options.token), ...options.headers };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + url, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: response.status, json, text, headers: response.headers };
}

/** Register a new account and return its session token. */
export async function registerUser(base: string, email = `user${Date.now()}-${(userCounter += 1)}@example.com`, password = 'password123'): Promise<{ token: string; userId: string; email: string; password: string }> {
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'subly' },
    body: JSON.stringify({ email, password, name: 'Tester' }),
  });
  const json: any = await response.json();
  if (response.status !== 201) throw new Error(`register failed: ${response.status} ${JSON.stringify(json)}`);
  const cookie = response.headers.get('set-cookie') ?? '';
  const token = /subly_session=([^;]+)/.exec(cookie)?.[1];
  if (!token) throw new Error('no session cookie');
  return { token: decodeURIComponent(token), userId: json.user.id, email, password };
}

/** Create a project. Without `session` a brand-new account owns it (so two calls = two different owners). */
export async function createProject(base: string, body: Record<string, unknown> = { sourceLanguage: 'en', targetLanguage: 'none' }, session?: { token: string; userId: string }): Promise<Created> {
  const owner = session ?? (await registerUser(base));
  const res = await api(base, 'POST', '/api/projects', { body, token: owner.token });
  if (res.status !== 201) throw new Error(`createProject failed: ${res.status} ${res.text}`);
  return { id: res.json.project.id, token: owner.token, userId: owner.userId };
}

/** fetch() with the owner's session cookie (for video / render downloads). */
export function authedFetch(url: string, created: { token: string }, init: RequestInit = {}) {
  return fetch(url, { ...init, headers: { ...authHeaders(created.token), ...(init.headers as Record<string, string> | undefined) } });
}

export async function upload(base: string, created: Created, data: Uint8Array, fileName = 'clip.mp4', contentType = 'video/mp4') {
  const response = await fetch(`${base}/api/projects/${created.id}/video`, {
    method: 'PUT',
    headers: { ...authHeaders(created.token), 'X-File-Name': encodeURIComponent(fileName), 'Content-Type': contentType },
    body: data as never,
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

/** Poll until the project's AI job is no longer running. */
export async function waitForJob(base: string, created: Created, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const res = await api(base, 'GET', `/api/projects/${created.id}?summary=1`, { token: created.token });
    if (res.json.project.job?.state !== 'running') return res.json.project;
    if (Date.now() > end) throw new Error('job did not finish in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}
