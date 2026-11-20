import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { api, authedFetch, authHeaders, createProject, fakeProviders, makeTestVideo, registerUser, startServer, upload, waitForJob } from '../helpers.ts';
import type { TestServer } from '../helpers.ts';
import { loadConfig } from '../../server/src/config.ts';
import { signStripePayload } from '../../server/src/services/payments/stripe.ts';

let server: TestServer;
let video: Uint8Array;
let voice: Uint8Array;

before(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'subly-wf-'));
  video = await readFile(makeTestVideo(path.join(dir, 'clip.mp4'), 6));
  const wav = path.join(dir, 'vo.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', wav], { stdio: 'pipe' });
  voice = await readFile(wav);
  server = await startServer({ providers: fakeProviders('ok') });
});
after(async () => {
  await server.close();
});

let currentBase = (): string => server.base;
const balance = async (token: string) => (await api(currentBase(), 'GET', '/api/auth/me', { token })).json.credits;

test('accounts: register, session cookie, me, logout, login, wrong password', async () => {
  const anon = await api(server.base, 'GET', '/api/auth/me');
  assert.equal(anon.json.user, null);
  const res = await fetch(`${server.base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'subly' }, body: JSON.stringify({ email: 'Maya@Example.com', password: 'longenough1', name: 'Maya' }) });
  assert.equal(res.status, 201);
  const cookie = res.headers.get('set-cookie') ?? '';
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const body: any = await res.json();
  assert.equal(JSON.stringify(body).includes('password'), false, 'no password data is ever returned');
  assert.equal(body.credits.free, 30);
  const token = /subly_session=([^;]+)/.exec(cookie)?.[1] as string;
  assert.equal((await api(server.base, 'GET', '/api/auth/me', { token })).json.user.email, 'maya@example.com');
  assert.equal((await api(server.base, 'POST', '/api/auth/logout', { token })).status, 204);
  assert.equal((await api(server.base, 'GET', '/api/auth/me', { token })).json.user, null, 'the session is dead after logout');
  const bad = await api(server.base, 'POST', '/api/auth/login', { body: { email: 'maya@example.com', password: 'nope-nope' } });
  assert.equal(bad.status, 401);
  const ok = await api(server.base, 'POST', '/api/auth/login', { body: { email: 'maya@example.com', password: 'longenough1' } });
  assert.equal(ok.status, 200);
  const dup = await api(server.base, 'POST', '/api/auth/register', { body: { email: 'maya@example.com', password: 'longenough1' } });
  assert.equal(dup.status, 409);
});

test('credits: generation is charged up front, shown in the ledger, and refunded when it fails', async () => {
  const p = await createProject(server.base, {});
  await upload(server.base, p, video);
  const est = await api(server.base, 'GET', `/api/projects/${p.id}/estimate?target=es`, { token: p.token });
  assert.equal(est.json.credits, 2, '6 s video: 1 credit transcription + 1 credit translation');
  await api(server.base, 'PUT', `/api/projects/${p.id}`, { token: p.token, body: { sourceLanguage: 'en', targetLanguage: 'es' } });
  const start = await api(server.base, 'POST', `/api/projects/${p.id}/transcribe`, { token: p.token, body: {} });
  assert.equal(start.status, 202);
  assert.equal(start.json.project.job.charges, undefined, 'internal charge ids are not exposed');
  const done = await waitForJob(server.base, p);
  assert.equal(done.job.state, 'succeeded');
  assert.equal((await balance(p.token)).total, 28);
  const ledger = (await api(server.base, 'GET', '/api/billing/ledger', { token: p.token })).json.entries;
  assert.deepEqual(ledger.filter((e: any) => e.kind === 'spend').map((e: any) => e.delta).sort(), [-1, -1]);

  const failing = await startServer({ providers: fakeProviders('rate_limited') });
  try {
    const q = await createProject(failing.base, { sourceLanguage: 'en', targetLanguage: 'none' });
    await upload(failing.base, q, video);
    await api(failing.base, 'POST', `/api/projects/${q.id}/transcribe`, { token: q.token, body: {} });
    const state = await waitForJob(failing.base, q);
    assert.equal(state.job.state, 'failed');
    const me = (await api(failing.base, 'GET', '/api/auth/me', { token: q.token })).json;
    assert.equal(me.credits.total, 30, 'the credit came back');
    const kinds = (await api(failing.base, 'GET', '/api/billing/ledger', { token: q.token })).json.entries.map((e: any) => e.kind);
    assert.ok(kinds.includes('spend') && kinds.includes('refund'));
  } finally {
    await failing.close();
  }
});

test('credits: with no credits left nothing starts (402) and the balance is unchanged', async () => {
  const broke = await startServer({ providers: fakeProviders('ok'), config: { billing: loadConfig({ FREE_MONTHLY_CREDITS: '0', PAYMENTS_MODE: 'demo' }).billing } });
  try {
    const p = await createProject(broke.base, { sourceLanguage: 'en', targetLanguage: 'none' });
    await upload(broke.base, p, video);
    const res = await api(broke.base, 'POST', `/api/projects/${p.id}/transcribe`, { token: p.token, body: {} });
    assert.equal(res.status, 402);
    assert.equal(res.json.error.code, 'insufficient_credits');
    const project = (await api(broke.base, 'GET', `/api/projects/${p.id}`, { token: p.token })).json.project;
    assert.equal(project.job, null, 'no job was started');
    // manual editing and subtitle-file export data stay free
    const save = await api(broke.base, 'PUT', `/api/projects/${p.id}`, { token: p.token, body: { subtitles: [{ id: 'a', start: 0, end: 2, text: 'Hi' }] } });
    assert.equal(save.status, 200);
    const render = await api(broke.base, 'POST', `/api/projects/${p.id}/render`, { token: p.token, body: {} });
    assert.equal(render.status, 402);
    const notes = (await api(broke.base, 'GET', '/api/notifications', { token: p.token })).json;
    assert.ok(notes.items.some((n: any) => n.kind === 'credits_empty'), 'low-credit notification was created');
  } finally {
    await broke.close();
  }
});

test('video export costs credits and is refunded if it fails', async () => {
  const p = await createProject(server.base, { sourceLanguage: 'en', targetLanguage: 'none' });
  await upload(server.base, p, video);
  await api(server.base, 'PUT', `/api/projects/${p.id}`, { token: p.token, body: { subtitles: [{ id: 'a', start: 0, end: 2, text: 'Hello' }] } });
  const start = await api(server.base, 'POST', `/api/projects/${p.id}/render`, { token: p.token, body: {} });
  assert.equal(start.status, 202);
  assert.equal(start.json.render.chargeId, undefined);
  assert.equal(start.json.render.creditsCharged, 1);
  for (let i = 0; i < 200; i += 1) {
    const r = (await api(server.base, 'GET', `/api/projects/${p.id}/render`, { token: p.token })).json.render;
    if (r.state !== 'running') break;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  assert.equal((await balance(p.token)).total, 29);
});

test('trim + voice-over: prepare cuts the video, mixes in the voice-over, and timeline pictures are created', async () => {
  const p = await createProject(server.base, {});
  await upload(server.base, p, video);
  const badVo = await fetch(`${server.base}/api/projects/${p.id}/voiceover`, { method: 'PUT', headers: { ...authHeaders(p.token), 'X-File-Name': 'x.mp3', 'Content-Type': 'application/octet-stream' }, body: new TextEncoder().encode('not audio') });
  assert.equal(badVo.status, 415);
  const vo = await fetch(`${server.base}/api/projects/${p.id}/voiceover`, { method: 'PUT', headers: { ...authHeaders(p.token), 'X-File-Name': 'vo.wav', 'Content-Type': 'audio/wav' }, body: voice as never });
  assert.equal(vo.status, 200);
  assert.equal(((await vo.json()) as any).project.media.voiceover.originalName, 'vo.wav');

  const bad = await api(server.base, 'POST', `/api/projects/${p.id}/prepare`, { token: p.token, body: { trimStart: 4, trimEnd: 3 } });
  assert.equal(bad.status, 400);
  const start = await api(server.base, 'POST', `/api/projects/${p.id}/prepare`, { token: p.token, body: { trimStart: 1, trimEnd: 4, useVoiceover: true } });
  assert.equal(start.status, 202);
  const done = await waitForJob(server.base, p);
  assert.equal(done.job.state, 'succeeded', JSON.stringify(done.job));
  const project = (await api(server.base, 'GET', `/api/projects/${p.id}`, { token: p.token })).json.project;
  assert.ok(Math.abs(project.media.duration - 3) < 0.3, `trimmed to about 3 s, got ${project.media.duration}`);
  assert.equal(project.media.voiceover, null, 'the voice-over was merged and removed');
  assert.equal(project.media.prepared, true);
  assert.equal(project.media.hasAudio, true);
  assert.equal((await balance(p.token)).total, 30, 'preparing is free');

  const poster = await authedFetch(`${server.base}/api/projects/${p.id}/assets/poster`, p);
  assert.equal(poster.status, 200);
  assert.deepEqual([...new Uint8Array(await poster.arrayBuffer()).slice(0, 2)], [0xff, 0xd8]);
  const strip = await authedFetch(`${server.base}/api/projects/${p.id}/assets/strip`, p);
  assert.equal(strip.status, 200);
  await strip.arrayBuffer();
  const wave = await authedFetch(`${server.base}/api/projects/${p.id}/assets/waveform`, p);
  assert.equal(wave.status, 200);
  assert.deepEqual([...new Uint8Array(await wave.arrayBuffer()).slice(1, 4)], [0x50, 0x4e, 0x47]);
  const stranger = await createProject(server.base, {});
  assert.equal((await authedFetch(`${server.base}/api/projects/${p.id}/assets/poster`, stranger)).status, 404);

  await api(server.base, 'PUT', `/api/projects/${p.id}`, { token: p.token, body: { subtitles: [{ id: 'a', start: 0, end: 1, text: 'x' }] } });
  const late = await api(server.base, 'POST', `/api/projects/${p.id}/prepare`, { token: p.token, body: { trimStart: 0, trimEnd: 2 } });
  assert.equal(late.status, 409, 'cannot trim after subtitles exist');
});

test('trim only (no voice-over) and recent-projects list', async () => {
  const p = await createProject(server.base, {});
  await upload(server.base, p, video);
  await api(server.base, 'POST', `/api/projects/${p.id}/prepare`, { token: p.token, body: { trimStart: 0, trimEnd: 2.5 } });
  const done = await waitForJob(server.base, p);
  assert.equal(done.job.state, 'succeeded');
  const list = (await api(server.base, 'GET', '/api/projects', { token: p.token })).json.projects;
  assert.equal(list.length, 1);
  assert.ok(Math.abs(list[0].media.duration - 2.5) < 0.3);
  assert.equal(list[0].subtitles, undefined, 'the list is a summary without subtitles');
});

test('payments (demo mode): buy a pack, subscribe, history, cancel, no double credit', async () => {
  const u = await registerUser(server.base);
  const info = (await api(server.base, 'GET', '/api/billing', { token: u.token })).json;
  assert.equal(info.mode, 'demo');
  assert.ok(info.catalog.length >= 4);
  const co = await api(server.base, 'POST', '/api/billing/checkout', { token: u.token, body: { itemId: 'pack_100' } });
  assert.match(co.json.url, /^\/demo-checkout\//);
  assert.equal((await api(server.base, 'POST', '/api/billing/checkout', { token: u.token, body: { itemId: 'nope' } })).status, 400);
  assert.equal((await balance(u.token)).paid, 0, 'nothing is granted before payment');
  const other = await registerUser(server.base);
  assert.equal((await api(server.base, 'POST', `/api/billing/demo/${co.json.paymentId}/pay`, { token: other.token })).status, 404, 'cannot pay someone else\'s checkout');
  assert.equal((await api(server.base, 'POST', `/api/billing/demo/${co.json.paymentId}/pay`, { token: u.token })).json.status, 'paid');
  await api(server.base, 'POST', `/api/billing/demo/${co.json.paymentId}/pay`, { token: u.token });
  assert.equal((await balance(u.token)).paid, 100, 'paying twice grants once');
  const sub = await api(server.base, 'POST', '/api/billing/checkout', { token: u.token, body: { itemId: 'pro' } });
  await api(server.base, 'POST', `/api/billing/demo/${sub.json.paymentId}/pay`, { token: u.token });
  const after = (await api(server.base, 'GET', '/api/billing', { token: u.token })).json;
  assert.equal(after.subscription.plan, 'pro');
  assert.equal(after.credits.paid, 400);
  const payments = (await api(server.base, 'GET', '/api/billing/payments', { token: u.token })).json.payments;
  assert.deepEqual(payments.map((x: any) => x.status).sort(), ['paid', 'paid']);
  const again = await api(server.base, 'POST', '/api/billing/checkout', { token: u.token, body: { itemId: 'pro' } });
  assert.equal(again.status, 409);
  await api(server.base, 'POST', '/api/billing/demo-cancel-subscription', { token: u.token });
  assert.equal((await api(server.base, 'GET', '/api/billing', { token: u.token })).json.subscription.plan, 'free');
  const notes = (await api(server.base, 'GET', '/api/notifications', { token: u.token })).json;
  assert.ok(notes.items.filter((n: any) => n.kind === 'purchase').length === 2);
  await api(server.base, 'POST', '/api/notifications/read', { token: u.token });
  assert.equal((await api(server.base, 'GET', '/api/notifications', { token: u.token })).json.unread, 0);
  assert.equal((await api(server.base, 'POST', '/api/billing/webhook', { body: {} })).status, 404, 'the webhook does not exist in demo mode');
});

// ---------------------------------------------------------------------- Stripe against a LOCAL MOCK
test('payments (stripe mode, local mock of Stripe): checkout request, signed webhooks, replay, bad signature', async () => {
  const seen: { path: string; body: URLSearchParams; auth: string | undefined }[] = [];
  const mock: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ path: req.url ?? '', body: new URLSearchParams(Buffer.concat(chunks).toString()), auth: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: `cs_test_${seen.length}`, url: `https://checkout.stripe.test/pay/${seen.length}` }));
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const port = (mock.address() as { port: number }).port;
  const secret = 'whsec_test_123';
  const billing = loadConfig({ STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: secret, PUBLIC_URL: 'https://subly.example', STRIPE_API_BASE: `http://127.0.0.1:${port}` }).billing;
  assert.equal(billing.paymentsMode, 'stripe');
  const s = await startServer({ providers: fakeProviders(), config: { billing } });
  currentBase = () => s.base;
  try {
    const u = await registerUser(s.base);
    const co = await api(s.base, 'POST', '/api/billing/checkout', { token: u.token, body: { itemId: 'pack_500' } });
    assert.equal(co.status, 200);
    assert.match(co.json.url, /^https:\/\/checkout\.stripe\.test\//);
    const req = seen[0];
    assert.equal(req.path, '/v1/checkout/sessions');
    assert.equal(req.auth, 'Bearer sk_test_abc');
    assert.equal(req.body.get('mode'), 'payment');
    assert.equal(req.body.get('line_items[0][price_data][unit_amount]'), '2000');
    assert.equal(req.body.get('metadata[user_id]'), u.userId);
    assert.equal(req.body.get('success_url'), 'https://subly.example/billing?checkout=success');
    assert.equal((await balance(u.token)).paid, 0, 'no credits until Stripe confirms');

    const post = (payload: object, sig?: string) => {
      const raw = JSON.stringify(payload);
      return fetch(`${s.base}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig ?? signStripePayload(raw, secret) }, body: raw });
    };
    const completed = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', payment_status: 'paid', customer: 'cus_1', metadata: { payment_id: co.json.paymentId, user_id: u.userId } } } };
    assert.equal((await post(completed, 't=1,v1=deadbeef')).status, 400, 'bad signature refused');
    assert.equal((await post(completed, signStripePayload(JSON.stringify(completed), 'wrong-secret'))).status, 400);
    assert.equal((await balance(u.token)).paid, 0);
    assert.equal((await post(completed)).status, 200);
    assert.equal((await balance(u.token)).paid, 500);
    const replay = await post(completed);
    assert.equal(((await replay.json()) as any).duplicate, true);
    const sameSessionNewEvent = await post({ ...completed, id: 'evt_2' });
    assert.equal(sameSessionNewEvent.status, 200);
    assert.equal((await balance(u.token)).paid, 500, 'the same payment is never credited twice');

    const sub = await api(s.base, 'POST', '/api/billing/checkout', { token: u.token, body: { itemId: 'studio' } });
    assert.equal(seen[1].body.get('mode'), 'subscription');
    assert.equal(seen[1].body.get('line_items[0][price_data][recurring][interval]'), 'month');
    assert.equal(seen[1].body.get('customer'), 'cus_1');
    const invoice = { id: 'evt_3', type: 'invoice.paid', data: { object: { id: 'in_1', customer: 'cus_1', subscription: 'sub_1', amount_paid: 2900, subscription_details: { metadata: { user_id: u.userId, plan: 'studio', payment_id: sub.json.paymentId } } } } };
    assert.equal((await post(invoice)).status, 200);
    const acct = (await api(s.base, 'GET', '/api/billing', { token: u.token })).json;
    assert.equal(acct.subscription.plan, 'studio');
    assert.equal(acct.credits.paid, 1700);
    await post({ ...invoice, id: 'evt_4' });
    assert.equal((await balance(u.token)).paid, 1700, 'the same invoice is never credited twice');
    const renewal = { ...invoice, id: 'evt_5', data: { object: { ...invoice.data.object, id: 'in_2' } } };
    await post(renewal);
    assert.equal((await balance(u.token)).paid, 2900, 'a new invoice (monthly renewal) adds the plan credits again');
    await post({ id: 'evt_6', type: 'customer.subscription.deleted', data: { object: { customer: 'cus_1' } } });
    assert.equal((await api(s.base, 'GET', '/api/billing', { token: u.token })).json.subscription.plan, 'free');
    const payments = (await api(s.base, 'GET', '/api/billing/payments', { token: u.token })).json.payments;
    assert.equal(payments.filter((x: any) => x.status === 'paid').length, 3);
    assert.equal((await api(s.base, 'POST', '/api/billing/demo/x/pay', { token: u.token })).status, 404, 'demo endpoints are off in stripe mode');
  } finally {
    currentBase = () => server.base;
    await s.close();
    mock.close();
  }
});

test('payments are refused when switched off or misconfigured', async () => {
  const misconfigured = loadConfig({ PAYMENTS_MODE: 'stripe' }).billing;
  assert.equal(misconfigured.paymentsMode, 'off');
  assert.match(misconfigured.paymentsNote, /STRIPE_SECRET_KEY/);
  const s = await startServer({ providers: fakeProviders(), config: { billing: misconfigured } });
  try {
    const u = await registerUser(s.base);
    const res = await api(s.base, 'POST', '/api/billing/checkout', { token: u.token, body: { itemId: 'pack_100' } });
    assert.equal(res.status, 503);
  } finally {
    await s.close();
  }
});
