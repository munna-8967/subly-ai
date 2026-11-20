import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { api, authedFetch, authHeaders, createProject, fakeProviders, makeTestVideo, registerUser, startServer, upload, waitForJob } from '../helpers.ts';
import type { TestServer } from '../helpers.ts';
import { createProviders } from '../../server/src/services/providers/index.ts';
import { loadConfig } from '../../server/src/config.ts';

let server: TestServer;
let video: Uint8Array;
const good = [
  { id: 'a', start: 0, end: 3, text: 'Welcome to my video.' },
  { id: 'b', start: 3, end: 3.9, text: "Let's start learning!" },
];

before(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'subly-vid-'));
  video = await readFile(makeTestVideo(path.join(dir, 'clip.mp4')));
  server = await startServer({ providers: fakeProviders('ok') });
});
after(async () => {
  await server.close();
});

// -------------------------------------------------------------------- basics
test('GET /api/config describes limits, languages and providers', async () => {
  const res = await api(server.base, 'GET', '/api/config');
  assert.equal(res.status, 200);
  assert.ok(res.json.languages.length > 5);
  assert.ok(res.json.limits.maxUploadBytes > 0);
  assert.equal(res.json.providers.transcription.configured, true);
  assert.equal(res.json.render.retentionHours, server.config.renderRetentionHours);
});

test('errors use one consistent JSON shape and never leak internals', async () => {
  const missing = await api(server.base, 'GET', '/api/nope');
  assert.equal(missing.status, 404);
  assert.equal(typeof missing.json.error.code, 'string');
  assert.equal(typeof missing.json.error.message, 'string');
  const wrongMethod = await api(server.base, 'DELETE', '/api/config');
  assert.equal(wrongMethod.status, 405);
  const user = await registerUser(server.base);
  const badJson = await fetch(`${server.base}/api/projects`, { method: 'POST', headers: { ...authHeaders(user.token), 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(badJson.status, 400);
  const text = JSON.stringify(await badJson.json());
  assert.ok(!/at \w+.*\.ts|node_modules|stack/i.test(text));
});

// -------------------------------------------------------------------- project creation
test('creating a project needs a signed-in user and valid, different languages', async () => {
  const anon = await api(server.base, 'POST', '/api/projects', { body: {} });
  assert.equal(anon.status, 401);
  const u = await registerUser(server.base);
  const post = (body: unknown) => api(server.base, 'POST', '/api/projects', { body, token: u.token });
  assert.equal((await post({ sourceLanguage: 'xx', targetLanguage: 'none' })).status, 400);
  const same = await post({ sourceLanguage: 'en', targetLanguage: 'en' });
  assert.equal(same.status, 400);
  assert.match(same.json.error.message, /same/i);
  assert.equal((await post([])).status, 400);
  const noLanguages = await post({});
  assert.equal(noLanguages.status, 201, 'languages are chosen later, in the language step');
  assert.equal(noLanguages.json.project.sourceLanguage, 'auto');
  assert.equal(noLanguages.json.project.targetLanguage, 'none');
  const ok = await post({ sourceLanguage: 'auto', targetLanguage: 'hi' });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.project.status, 'empty');
  assert.equal(ok.json.project.tokenHash, undefined);
  assert.equal(ok.json.project.ownerId, undefined, 'internal ids are not sent to the browser');
  const noHeader = await fetch(`${server.base}/api/projects`, { method: 'POST', headers: { Cookie: `subly_session=${u.token}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403, 'a request without the CSRF header is refused');
});

// -------------------------------------------------------------------- upload
test('a real video uploads and is inspected by its contents', async () => {
  const created = await createProject(server.base);
  const res = await upload(server.base, created, video);
  assert.equal(res.status, 200);
  const media = res.json.project.media;
  assert.equal(media.width, 320);
  assert.equal(media.height, 240);
  assert.ok(Math.abs(media.duration - 4) < 0.5);
  assert.equal(media.hasAudio, true);
  assert.equal(res.json.project.name, 'clip');
  assert.equal(res.json.project.media.storedName, undefined, 'internal file names are not exposed');
  // a second upload to the same project is refused
  const again = await upload(server.base, created, video);
  assert.equal(again.status, 409);
});

test('unsupported extension, fake video and empty body are rejected by the server', async () => {
  const a = await createProject(server.base);
  const wrongExt = await upload(server.base, a, video, 'notes.txt', 'text/plain');
  assert.equal(wrongExt.status, 415);

  const b = await createProject(server.base);
  const fake = await upload(server.base, b, new TextEncoder().encode('this is definitely not a video'), 'fake.mp4', 'video/mp4');
  assert.equal(fake.status, 415);
  const check = await api(server.base, 'GET', `/api/projects/${b.id}`, { token: b.token });
  assert.equal(check.json.project.media, null, 'a rejected upload leaves no media behind');

  const c = await createProject(server.base);
  const empty = await upload(server.base, c, new Uint8Array(0));
  assert.equal(empty.status, 400);
});

test('files over the configured size limit are refused', async () => {
  const small = await startServer({ providers: fakeProviders(), config: { maxUploadBytes: 2048 } });
  try {
    const created = await createProject(small.base);
    const res = await upload(small.base, created, video);
    assert.equal(res.status, 413);
    assert.equal(res.json.error.code, 'file_too_large');
  } finally {
    await small.close();
  }
});

test('videos longer than the duration limit are refused', async () => {
  const short = await startServer({ providers: fakeProviders(), config: { maxDurationSeconds: 2 } });
  try {
    const created = await createProject(short.base);
    const res = await upload(short.base, created, video);
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, 'video_too_long');
  } finally {
    await short.close();
  }
});

// -------------------------------------------------------------------- access control
test('projects are private: signed-out, other accounts and bad ids all look like "not found"', async () => {
  const owner = await createProject(server.base);
  const other = await createProject(server.base);
  const noToken = await api(server.base, 'GET', `/api/projects/${owner.id}`);
  assert.equal(noToken.status, 401);
  const wrong = await api(server.base, 'GET', `/api/projects/${owner.id}`, { token: other.token });
  const badId = await api(server.base, 'GET', '/api/projects/..%2F..%2Fetc%2Fpasswd', { token: owner.token });
  const unknown = await api(server.base, 'GET', '/api/projects/00000000-0000-4000-8000-000000000000', { token: owner.token });
  for (const res of [wrong, badId, unknown]) assert.equal(res.status, 404);
  assert.equal(wrong.json.error.code, unknown.json.error.code);
  for (const method of ['PUT', 'DELETE']) {
    const res = await api(server.base, method, `/api/projects/${owner.id}`, { token: other.token, body: {} });
    assert.equal(res.status, 404);
  }
  const video404 = await authedFetch(`${server.base}/api/projects/${owner.id}/video`, other);
  assert.equal(video404.status, 404);
  const list = await api(server.base, 'GET', '/api/projects', { token: other.token });
  assert.deepEqual(list.json.projects.map((p: { id: string }) => p.id), [other.id], 'the list shows only my own projects');
});

// -------------------------------------------------------------------- subtitle editing + validation
test('subtitles can be saved, edited and deleted, and come back sorted', async () => {
  const created = await createProject(server.base);
  await upload(server.base, created, video);
  const saved = await api(server.base, 'PUT', `/api/projects/${created.id}`, { token: created.token, body: { subtitles: [...good].reverse() } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.project.subtitles.map((s: any) => s.id), ['a', 'b']);
  assert.equal(saved.json.project.status, 'ready');

  const edited = good.map((s) => (s.id === 'a' ? { ...s, text: '  Edited text  ', end: 2.5 } : s));
  const res = await api(server.base, 'PUT', `/api/projects/${created.id}`, { token: created.token, body: { subtitles: edited } });
  assert.equal(res.json.project.subtitles[0].text, 'Edited text');
  assert.equal(res.json.project.subtitles[0].end, 2.5);

  const deleted = await api(server.base, 'PUT', `/api/projects/${created.id}`, { token: created.token, body: { subtitles: [good[1]] } });
  assert.equal(deleted.json.project.subtitles.length, 1);
  const empty = await api(server.base, 'PUT', `/api/projects/${created.id}`, { token: created.token, body: { subtitles: [] } });
  assert.equal(empty.status, 200);
  assert.equal(empty.json.project.subtitleCount, 0);
});

test('invalid subtitles are rejected and nothing is saved', async () => {
  const created = await createProject(server.base);
  await upload(server.base, created, video);
  await api(server.base, 'PUT', `/api/projects/${created.id}`, { token: created.token, body: { subtitles: good } });
  const bad: [string, unknown][] = [
    ['end before start', [{ id: 'x', start: 2, end: 1, text: 'hi' }]],
    ['end equals start', [{ id: 'x', start: 2, end: 2, text: 'hi' }]],
    ['negative start', [{ id: 'x', start: -1, end: 1, text: 'hi' }]],
    ['string time', [{ id: 'x', start: '0', end: 1, text: 'hi' }]],
    ['null time', [{ id: 'x', start: null, end: 1, text: 'hi' }]],
    ['empty text', [{ id: 'x', start: 0, end: 1, text: '   ' }]],
    ['duplicate ids', [{ id: 'x', start: 0, end: 1, text: 'a' }, { id: 'x', start: 1, end: 2, text: 'b' }]],
    ['unsafe id', [{ id: '../x', start: 0, end: 1, text: 'a' }]],
    ['past the end of the video', [{ id: 'x', start: 10, end: 12, text: 'late' }]],
    ['not an array', { id: 'x' }],
  ];
  for (const [label, subtitles] of bad) {
    const res = await api(server.base, 'PUT', `/api/projects/${created.id}`, { token: created.token, body: { subtitles } });
    assert.equal(res.status, 400, label);
    assert.equal(res.json.error.code, 'validation_error', label);
  }
  const after = await api(server.base, 'GET', `/api/projects/${created.id}`, { token: created.token });
  assert.deepEqual(after.json.project.subtitles.map((s: any) => s.id), ['a', 'b'], 'the good data is untouched');
});

test('style is validated and saved; project can be renamed', async () => {
  const created = await createProject(server.base);
  const bad = await api(server.base, 'PUT', `/api/projects/${created.id}`, { token: created.token, body: { style: { fontSize: 500 } } });
  assert.equal(bad.status, 400);
  const badColor = await api(server.base, 'PUT', `/api/projects/${created.id}`, { token: created.token, body: { style: { color: 'red' } } });
  assert.equal(badColor.status, 400);
  const ok = await api(server.base, 'PUT', `/api/projects/${created.id}`, { token: created.token, body: { name: 'My trip', style: { color: '#FFCC00', bold: true, position: 'top' } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.project.name, 'My trip');
  assert.equal(ok.json.project.style.color, '#ffcc00');
  assert.equal(ok.json.project.style.position, 'top');
  const blank = await api(server.base, 'PUT', `/api/projects/${created.id}`, { token: created.token, body: { name: '   ' } });
  assert.equal(blank.status, 400);
});

// -------------------------------------------------------------------- persistence
test('projects survive a server restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'subly-persist-'));
  const first = await startServer({ providers: fakeProviders(), dataDir: dir, keepData: true });
  const created = await createProject(first.base);
  await upload(first.base, created, video);
  await api(first.base, 'PUT', `/api/projects/${created.id}`, { token: created.token, body: { name: 'Persist me', subtitles: good, style: { color: '#00ff00' } } });
  await first.close();

  const second = await startServer({ providers: fakeProviders(), dataDir: dir });
  try {
    const res = await api(second.base, 'GET', `/api/projects/${created.id}`, { token: created.token });
    assert.equal(res.status, 200);
    assert.equal(res.json.project.name, 'Persist me');
    assert.deepEqual(res.json.project.subtitles, good);
    assert.equal(res.json.project.style.color, '#00ff00');
    const media = await authedFetch(`${second.base}/api/projects/${created.id}/video`, created, { headers: { Range: 'bytes=0-99' } });
    assert.equal(media.status, 206, 'the video is still there and supports Range requests');
    await media.arrayBuffer();
  } finally {
    await second.close();
  }
});

// -------------------------------------------------------------------- transcription + translation
test('transcription without an API key explains how to set it up and does not crash', async () => {
  const config = loadConfig({}, { port: 0 });
  const noKey = await startServer({ providers: createProviders(config) });
  try {
    const cfg = await api(noKey.base, 'GET', '/api/config');
    assert.equal(cfg.json.providers.transcription.configured, false);
    const created = await createProject(noKey.base);
    await upload(noKey.base, created, video);
    const res = await api(noKey.base, 'POST', `/api/projects/${created.id}/transcribe`, { token: created.token, body: {} });
    assert.equal(res.status, 503, 'service unavailable, with a setup message');
    assert.equal(res.json.error.code, 'provider_not_configured');
    assert.match(res.json.error.message, /OPENAI_API_KEY|not configured|set up/i);
    // manual editing still works
    const manual = await api(noKey.base, 'PUT', `/api/projects/${created.id}`, { token: created.token, body: { subtitles: good } });
    assert.equal(manual.status, 200);
  } finally {
    await noKey.close();
  }
});

test('AI transcription creates editable subtitles and refuses to overwrite silently', async () => {
  const created = await createProject(server.base, { sourceLanguage: 'auto', targetLanguage: 'none' });
  await upload(server.base, created, video);
  const start = await api(server.base, 'POST', `/api/projects/${created.id}/transcribe`, { token: created.token, body: {} });
  assert.equal(start.status, 202);
  assert.equal(start.json.project.job.state, 'running');
  const done = await waitForJob(server.base, created);
  assert.equal(done.job.state, 'succeeded', JSON.stringify(done.job));
  const full = await api(server.base, 'GET', `/api/projects/${created.id}`, { token: created.token });
  assert.equal(full.json.project.subtitles.length, 2);
  assert.equal(full.json.project.subtitles[0].text, 'Welcome to my video.');
  assert.equal(full.json.project.status, 'ready');

  const again = await api(server.base, 'POST', `/api/projects/${created.id}/transcribe`, { token: created.token, body: {} });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, 'subtitles_exist');
  const forced = await api(server.base, 'POST', `/api/projects/${created.id}/transcribe`, { token: created.token, body: { overwrite: true } });
  assert.equal(forced.status, 202);
  await waitForJob(server.base, created);
});

test('translation keeps the original text and timing, and each translation stays with its segment', async () => {
  const created = await createProject(server.base);
  await upload(server.base, created, video);
  await api(server.base, 'PUT', `/api/projects/${created.id}`, { token: created.token, body: { subtitles: good } });
  const noTarget = await api(server.base, 'POST', `/api/projects/${created.id}/translate`, { token: created.token, body: {} });
  assert.equal(noTarget.status, 400, 'target "none" is not a translation target');
  const start = await api(server.base, 'POST', `/api/projects/${created.id}/translate`, { token: created.token, body: { targetLanguage: 'es' } });
  assert.equal(start.status, 202);
  const done = await waitForJob(server.base, created);
  assert.equal(done.job.state, 'succeeded', JSON.stringify(done.job));
  const full = (await api(server.base, 'GET', `/api/projects/${created.id}`, { token: created.token })).json.project;
  assert.deepEqual(full.subtitles.map((s: any) => [s.id, s.start, s.end, s.text]), good.map((s) => [s.id, s.start, s.end, s.text]));
  assert.match(full.subtitles[0].translation, /^\[Spanish\] Welcome to my video\.$/);
  assert.match(full.subtitles[1].translation, /Let's start learning/);
  // a human edit to a translation is kept when re-translating only what is missing
  const edited = full.subtitles.map((s: any) => (s.id === 'a' ? { ...s, translation: 'Bienvenido (editado)' } : s));
  await api(server.base, 'PUT', `/api/projects/${created.id}`, { token: created.token, body: { subtitles: edited } });
  await api(server.base, 'POST', `/api/projects/${created.id}/translate`, { token: created.token, body: { targetLanguage: 'es', overwrite: false } });
  await waitForJob(server.base, created);
  const after = (await api(server.base, 'GET', `/api/projects/${created.id}`, { token: created.token })).json.project;
  assert.equal(after.subtitles[0].translation, 'Bienvenido (editado)');
});

test('provider failures become a clear failed job, not a crash', async () => {
  const busy = await startServer({ providers: fakeProviders('rate_limited') });
  try {
    const created = await createProject(busy.base);
    await upload(busy.base, created, video);
    const start = await api(busy.base, 'POST', `/api/projects/${created.id}/transcribe`, { token: created.token, body: {} });
    assert.equal(start.status, 202);
    const done = await waitForJob(busy.base, created);
    assert.equal(done.job.state, 'failed');
    assert.match(done.job.error, /rate limit|busy/i);
    assert.equal(done.status, 'failed');
  } finally {
    await busy.close();
  }
  const silent = await startServer({ providers: fakeProviders('silent') });
  try {
    const created = await createProject(silent.base);
    await upload(silent.base, created, video);
    await api(silent.base, 'POST', `/api/projects/${created.id}/transcribe`, { token: created.token, body: {} });
    const done = await waitForJob(silent.base, created);
    assert.equal(done.job.state, 'failed');
    assert.match(done.job.error, /no speech/i);
  } finally {
    await silent.close();
  }
});

// -------------------------------------------------------------------- rendering
test('burned-in video renders, reports progress and downloads as MP4', async (t) => {
  if (!server.app.renders.support.available) {
    t.skip(`rendering unavailable: ${server.app.renders.support.reason}`);
    return;
  }
  const created = await createProject(server.base);
  await upload(server.base, created, video);
  const none = await api(server.base, 'POST', `/api/projects/${created.id}/render`, { token: created.token, body: {} });
  assert.equal(none.status, 422, 'cannot render without subtitles');
  await api(server.base, 'PUT', `/api/projects/${created.id}`, { token: created.token, body: { subtitles: good, style: { color: '#ffee00', position: 'top' } } });
  const start = await api(server.base, 'POST', `/api/projects/${created.id}/render`, { token: created.token, body: { track: 'original' } });
  assert.equal(start.status, 202);
  let render = start.json.render;
  const end = Date.now() + 60_000;
  while (render.state === 'running' && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 300));
    render = (await api(server.base, 'GET', `/api/projects/${created.id}/render`, { token: created.token })).json.render;
  }
  assert.equal(render.state, 'succeeded', JSON.stringify(render));
  const file = await authedFetch(`${server.base}/api/projects/${created.id}/render/file`, created);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'video/mp4');
  assert.match(file.headers.get('content-disposition') ?? '', /attachment/);
  const bytes = new Uint8Array(await file.arrayBuffer());
  assert.ok(bytes.length > 1000);
  assert.equal(new TextDecoder().decode(bytes.slice(4, 8)), 'ftyp', 'it is an MP4 container');
  const stranger = await createProject(server.base);
  const wrongToken = await authedFetch(`${server.base}/api/projects/${created.id}/render/file`, stranger);
  assert.equal(wrongToken.status, 404);
});

// -------------------------------------------------------------------- delete + rate limit
test('deleting a project removes it and its files', async () => {
  const created = await createProject(server.base);
  await upload(server.base, created, video);
  const del = await api(server.base, 'DELETE', `/api/projects/${created.id}`, { token: created.token });
  assert.equal(del.status, 204);
  const gone = await api(server.base, 'GET', `/api/projects/${created.id}`, { token: created.token });
  assert.equal(gone.status, 404);
  const vid = await authedFetch(`${server.base}/api/projects/${created.id}/video`, created);
  assert.equal(vid.status, 404);
});

test('rate limiting answers 429 with Retry-After', async () => {
  const limited = await startServer({ providers: fakeProviders(), config: { rateLimit: { enabled: true, windowMs: 60_000, max: 5, heavyMax: 100 } } });
  try {
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 8; i += 1) {
      const res = await api(limited.base, 'GET', '/api/health');
      statuses.push(res.status);
      if (res.status === 429) retryAfter = res.headers.get('retry-after');
    }
    assert.ok(statuses.includes(429), statuses.join(','));
    assert.ok(retryAfter && Number(retryAfter) > 0);
  } finally {
    await limited.close();
  }
});

test('static files cannot escape the client folder', async () => {
  for (const url of ['/..%2f..%2fpackage.json', '/%2e%2e/package.json', '/shared/../package.json', '/.env']) {
    const res = await fetch(server.base + url);
    assert.ok(res.status === 404 || res.status === 400, `${url} -> ${res.status}`);
    const body = await res.text();
    assert.ok(!body.includes('"devDependencies"'), `${url} leaked a file`);
  }
});
