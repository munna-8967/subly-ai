// Browser end-to-end test: drives the real UI against a real server (fake AI providers, real FFmpeg, demo payments).
//
// Needs: `npm run build` first (so client/dist exists) and Playwright with Chromium:
//   npm i --no-save playwright && npx playwright install chromium
// Run:   node --disable-warning=ExperimentalWarning tests/e2e/e2e.mjs      (E2E_SHOTS=/some/dir keeps screenshots)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeProviders, startServer } from '../helpers.ts';
import { loadConfig } from '../../server/src/config.ts';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const shots = process.env.E2E_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const tmp = mkdtempSync(path.join(os.tmpdir(), 'subly-e2e-'));
// WebM (VP8 + Opus) because Playwright's Chromium cannot play H.264.
const videoPath = path.join(tmp, 'clip.webm');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libvpx', '-b:v', '300k', '-c:a', 'libopus', '-shortest', videoPath]);
const voicePath = path.join(tmp, 'voice.wav');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=4', voicePath]);

const server = await startServer({ providers: fakeProviders('ok') });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const problems = [];
const watch = (p, label = '') => {
  p.on('pageerror', (e) => problems.push(`${label}pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // Expected: the app asks /api/auth/me while signed out and the browser logs 401s for deliberate failures.
    if (/status of 40[0-9]/.test(t)) return;
    problems.push(`${label}console: ${t}`);
  });
};
watch(page);

let step = 0;
const log = (name) => console.log(`  ✓ ${String(++step).padStart(2, '0')} ${name}`);
const shot = async (name, p = page) => { if (shots) await p.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true }); };
const text = (sel) => page.locator(sel).first().innerText();
const rows = () => page.locator('.sub-row');
const setRange = (sel, value) => page.evaluate(({ sel, value }) => {
  const el = document.querySelector(sel);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(value));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, { sel, value });
const seekTo = (t) => page.evaluate((time) => new Promise((resolve) => {
  const v = document.querySelector('.stage video');
  if (Math.abs(v.currentTime - time) < 0.01) return resolve();
  v.addEventListener('seeked', () => resolve(), { once: true });
  v.currentTime = time;
}), t);
const overlay = page.locator('[data-testid=subtitle-overlay]');
const credits = async (p = page) => Number(await p.locator('[data-testid=credit-total]').first().innerText());
const API = { 'X-Requested-With': 'subly' };

try {
  // ---------------------------------------------------------------- accounts
  await page.goto(server.base);
  await page.waitForURL(/\/login/);
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
  log('signed-out visitors land on the sign-in page');

  await page.getByRole('link', { name: 'Create an account' }).click();
  await page.fill('#auth-name', 'Maya Rao');
  await page.fill('#auth-email', 'maya@example.com');
  await page.fill('#auth-password', 'short');
  await page.getByRole('button', { name: 'Create account' }).click();
  // the browser's own minlength check blocks it, so we stay on the page
  await page.waitForTimeout(300);
  assert.match(page.url(), /\/register/);
  await page.fill('#auth-password', 'correct-horse-9');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByText('No projects yet').waitFor();
  assert.equal(await credits(), 30);
  await shot('01-home-empty');
  log('register -> home with 30 free credits and an empty-state');

  // log out and back in, wrong password first
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login/);
  await page.fill('#auth-email', 'maya@example.com');
  await page.fill('#auth-password', 'wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('E-mail or password is wrong.').waitFor();
  await page.fill('#auth-password', 'correct-horse-9');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('No projects yet').waitFor();
  log('sign out, wrong password is refused, sign in works');

  // ---------------------------------------------------------------- new project wizard
  await page.getByTestId('fab-new').click();
  await page.waitForURL(/\/new$/);
  assert.ok(await page.getByTestId('continue-media').isDisabled());
  await page.setInputFiles('[data-testid=video-input]', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.getByText(/Unsupported file type “\.txt”/).waitFor();
  log('floating + opens the wizard; wrong file type is refused; Continue is disabled without a video');

  await page.setInputFiles('[data-testid=video-input]', videoPath);
  await page.locator('#trim-start').waitFor();
  await page.waitForFunction(() => /Keeping .* of /.test(document.querySelector('[data-testid=trim-summary]')?.textContent ?? ''));
  const before = await text('[data-testid=trim-summary]');
  await setRange('#trim-start', 1);
  await setRange('#trim-end', 5);
  await page.waitForFunction((b) => document.querySelector('[data-testid=trim-summary]').textContent !== b, before);
  const summary = await text('[data-testid=trim-summary]');
  assert.match(summary, /Keeping 0?0?:?0?4/);
  await page.getByRole('button', { name: 'Set end to playhead' }).waitFor();
  await shot('02-trim');
  log('video preview shows trim controls; moving the sliders changes the kept length');

  await page.setInputFiles('[data-testid=voice-input]', voicePath);
  await page.getByTestId('voice-name').waitFor();
  assert.equal(await text('[data-testid=voice-name]'), 'voice.wav');
  log('optional voice-over can be added');

  await page.getByTestId('continue-media').click();
  await page.getByRole('heading', { name: '2. Languages' }).waitFor({ timeout: 60_000 });
  const list = await (await page.request.get(`${server.base}/api/projects`)).json();
  assert.equal(list.projects.length, 1);
  const projectId = list.projects[0].id;
  assert.ok(Math.abs(list.projects[0].media.duration - 4) < 0.4, `trimmed to about 4 s, got ${list.projects[0].media.duration}`);
  assert.equal(list.projects[0].media.voiceover, null);
  assert.equal(list.projects[0].media.prepared, true);
  log('Continue uploads, applies trim + voice-over on the server (about 4 s left), and opens language selection');

  await page.selectOption('#source-language', 'en');
  await page.selectOption('#target-language', 'en');
  await page.getByText(/languages are the same/).waitFor();
  assert.ok(await page.getByTestId('generate').isDisabled());
  await page.selectOption('#source-language', 'auto');
  await page.selectOption('#target-language', 'es');
  assert.match(await text('[data-testid=cost-box]'), /2 credits/);
  await shot('03-languages');
  log('same-language is refused; the price (2 credits: transcription + translation) is shown before starting');

  await page.getByTestId('generate').click();
  await page.waitForURL(/\/editor\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  await rows().first().waitFor({ timeout: 20_000 });
  assert.equal(await rows().count(), 2);
  assert.match(await text('.sub-translation'), /^\[Spanish\] Welcome to my video\.$/);
  assert.equal(await credits(), 28);
  log('AI subtitles are generated and translated; 2 credits were charged');

  // ---------------------------------------------------------------- editor: timelines
  await page.waitForFunction(() => document.querySelector('.stage video')?.readyState >= 1, null, { timeout: 15_000 });
  await page.waitForFunction(() => { const i = document.querySelector('[data-testid=video-track] img.strip'); return i && i.naturalWidth > 0; }, null, { timeout: 30_000 });
  await page.waitForFunction(() => { const i = document.querySelector('[data-testid=video-track] img.wave'); return i && i.naturalWidth > 0; }, null, { timeout: 30_000 });
  assert.equal(await page.locator('.cap').count(), 2);
  assert.match(await page.locator('.cap').first().getAttribute('aria-label'), /Welcome to my video|Spanish/);
  assert.ok((await page.locator('.ruler .tick').count()) >= 3);
  await shot('04-editor');
  log('editor has a video timeline (thumbnails + waveform) and a subtitle timeline with a caption block per subtitle');

  await seekTo(1.0);
  await overlay.waitFor();
  assert.equal((await overlay.innerText()).trim(), '[Spanish] Welcome to my video.');
  const playheadX = async () => (await page.getByTestId('playhead').boundingBox()).x;
  const x1 = await playheadX();
  await seekTo(2.6);
  await page.waitForFunction(() => document.querySelector('[data-testid=subtitle-overlay]')?.textContent?.includes('start learning'));
  assert.ok((await playheadX()) > x1 + 10, 'the timeline playhead follows the video');
  await seekTo(3.95);
  await overlay.waitFor({ state: 'detached' });
  log('overlay and timeline playhead follow the video time');

  // click on the ruler seeks the video
  await page.getByTestId('timeline-scroll').scrollIntoViewIfNeeded(); // mouse coordinates are viewport based
  const box = await page.getByTestId('timeline-scroll').boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + 12);
  await page.waitForFunction(() => Math.abs(document.querySelector('.stage video').currentTime - 2) < 0.6);
  log('clicking the timeline seeks the video');

  // drag a caption to move it, drag its edge to resize it, and let AUTOSAVE store it (no Save click)
  const capBefore = await page.locator('.cap').first().getAttribute('aria-label');
  const first = await page.locator('.cap').first().boundingBox();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x + first.width / 2 + 40, first.y + first.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction((x) => Math.abs(document.querySelector('.cap').getBoundingClientRect().x - x) > 10, first.x);
  const afterMove = await page.locator('.cap').first().boundingBox();
  const handle = { x: afterMove.x + afterMove.width - 3, y: afterMove.y + afterMove.height / 2 };
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x + 30, handle.y, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction((w) => document.querySelector('.cap').getBoundingClientRect().width > w + 10, afterMove.width);
  log('dragging a caption moves it and dragging its edge resizes it');

  await page.getByText(/Autosaved/).waitFor({ timeout: 10_000 });
  const timed = await page.locator('.cap').first().getAttribute('aria-label');
  await page.reload();
  await page.locator('.cap').first().waitFor();
  assert.equal(await page.locator('.cap').first().getAttribute('aria-label'), timed);
  log('autosave stored the new timing without pressing Save (survives a reload)');

  // keyboard nudge
  await page.locator('.cap').first().focus();
  const nudgeX = (await page.locator('.cap').first().boundingBox()).x;
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction((x) => Math.abs(document.querySelector('.cap').getBoundingClientRect().x - x) > 3, nudgeX);
  log('a focused caption can be nudged with the arrow keys');

  // ---------------------------------------------------------------- editing text/time through the form
  await rows().first().locator('.sub-main').click();
  await page.waitForFunction(() => document.querySelector('#sub-text')?.value === 'Welcome to my video.');
  await page.fill('#sub-text', 'Hello edited');
  await page.fill('#sub-start', '00:00.500');
  await page.fill('#sub-end', '00:01.800');
  await page.getByRole('button', { name: 'Update subtitle' }).click();
  assert.match(await text('.sub-row'), /Hello edited/);
  await page.fill('#sub-end', 'abc');
  await page.getByRole('button', { name: 'Update subtitle' }).click();
  await page.getByText(/End time is not valid/).waitFor();
  await page.fill('#sub-end', '00:01.800');
  log('text and timestamps can be edited; invalid time is refused');

  await seekTo(3.0);
  await page.getByRole('button', { name: '+ Add subtitle' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.sub-row').length === 3);
  await page.getByRole('button', { name: 'Delete subtitle' }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.sub-row').length === 3);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.sub-row').length === 2);
  log('add, delete, undo, redo');

  // ---------------------------------------------------------------- presets + customization
  await page.getByTestId('preset-bold-pop').click();
  await seekTo(1.0);
  await overlay.waitFor();
  let css = await overlay.evaluate((el) => ({ color: getComputedStyle(el).color, weight: getComputedStyle(el).fontWeight, family: getComputedStyle(el).fontFamily }));
  assert.equal(css.color, 'rgb(255, 225, 77)');
  assert.ok(Number(css.weight) >= 700);
  assert.match(css.family, /Poppins/);
  await page.getByTestId('preset-boxed').click();
  css = await overlay.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor }));
  assert.equal(css.bg, 'rgba(0, 0, 0, 0.7)');
  await page.fill('#st-color', '#00ffcc');
  await page.locator('.segmented[aria-label=Position] label', { hasText: 'Top' }).click();
  await page.locator('.segmented[aria-label=Alignment] label', { hasText: 'Left' }).click();
  await page.locator('#st-font').selectOption('Georgia');
  await page.getByLabel('Italic').check();
  css = await overlay.evaluate((el) => ({ color: getComputedStyle(el).color, top: el.parentElement.style.top, italic: getComputedStyle(el).fontStyle, family: getComputedStyle(el).fontFamily, align: getComputedStyle(el.parentElement).textAlign }));
  assert.equal(css.color, 'rgb(0, 255, 204)');
  assert.ok(css.top && css.top !== 'auto');
  assert.equal(css.italic, 'italic');
  assert.match(css.family, /Georgia/);
  assert.equal(css.align, 'left');
  await shot('05-styled');
  log('presets and custom font, colour, background, italic, alignment and position drive the live preview');

  // ---------------------------------------------------------------- manual save + persistence
  await page.getByTestId('save').click();
  await page.getByText(/✓ Saved/).waitFor();
  await page.reload();
  await rows().first().waitFor();
  assert.match(await text('.sub-row'), /Hello edited/);
  assert.equal(await page.inputValue('#st-color'), '#00ffcc');
  log('Save project works and everything persists after a reload');

  // autosave can be switched off
  await page.getByLabel('Autosave').uncheck();
  await page.fill('#sub-search', 'x');
  await page.fill('#sub-search', '');
  await rows().first().locator('.sub-main').click();
  await page.fill('#sub-text', 'Hello edited again');
  await page.getByRole('button', { name: 'Update subtitle' }).click();
  await page.getByText('● Unsaved changes').waitFor();
  await page.waitForTimeout(3500);
  assert.ok(await page.getByText('● Unsaved changes').isVisible(), 'no autosave while it is switched off');
  await page.getByLabel('Autosave').check();
  await page.getByText(/Autosaved/).waitFor({ timeout: 10_000 });
  log('autosave can be turned off and on');

  // ---------------------------------------------------------------- export
  await page.getByRole('button', { name: 'Export →' }).click();
  await page.waitForURL(/\/export\//);
  await page.locator('pre.preview').waitFor();
  await page.selectOption('#export-track', 'original');
  let preview = await text('pre.preview');
  assert.match(preview, /^1\n00:00:00,500 --> 00:00:01,800\nHello edited again\n/);
  await page.selectOption('#export-format', 'vtt');
  assert.match(await text('pre.preview'), /^WEBVTT\n\n00:00:00\.500 --> 00:00:01\.800\nHello edited again/);
  await page.selectOption('#export-format', 'txt');
  preview = await text('pre.preview');
  assert.ok(!preview.includes('-->') && preview.startsWith('Hello edited again\n'));
  await page.fill('#file-name', 'my:bad/name');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download TXT' }).click()]);
  assert.equal(download.suggestedFilename(), 'my-bad-name.txt');
  assert.ok(readFileSync(await download.path(), 'utf8').includes('Hello edited again'));
  assert.equal(await credits(), 28, 'subtitle files are free');
  log('SRT, VTT and TXT exports are correct, downloadable, and free');

  await page.getByRole('button', { name: /Start rendering \(1 credit\)/ }).click();
  const link = page.getByRole('link', { name: /Download video/ });
  await link.waitFor({ timeout: 90_000 });
  const rendered = await page.request.get(server.base + (await link.getAttribute('href')));
  assert.equal(rendered.status(), 200);
  assert.equal(rendered.headers()['content-type'], 'video/mp4');
  assert.ok((await rendered.body()).length > 1000);
  await page.getByRole('link', { name: /Credits & billing/ }).first().click();
  await page.getByTestId('balance-total').waitFor();
  assert.equal(await credits(), 27);
  log('video export with embedded subtitles renders, downloads, and costs 1 credit');

  // ---------------------------------------------------------------- billing
  await page.getByTestId('demo-banner').waitFor();
  assert.equal(await text('[data-testid=balance-total]'), '27');
  assert.equal(await text('[data-testid=balance-free]'), '27 / 30');
  await shot('06-billing');
  await page.getByTestId('pack-pack_100').getByRole('button', { name: 'Buy pack' }).click();
  await page.waitForURL(/\/demo-checkout\//);
  await page.getByText('No real money is charged').waitFor();
  await page.getByTestId('demo-pay').click();
  await page.getByText(/Demo payment complete/).waitFor();
  assert.equal(await text('[data-testid=balance-total]'), '127');
  assert.equal(await text('[data-testid=balance-paid]'), '100');
  await page.getByTestId('plan-pro').getByRole('button', { name: 'Subscribe to Pro' }).click();
  await page.getByTestId('demo-pay').click();
  await page.getByText(/Demo payment complete/).waitFor();
  assert.equal(await text('[data-testid=plan-name]'), 'Pro');
  assert.equal(await text('[data-testid=balance-total]'), '427');
  const paymentRows = await page.locator('[data-testid=payments] tbody tr').allInnerTexts();
  assert.equal(paymentRows.length, 2);
  assert.ok(paymentRows.some((r) => /Pro plan/.test(r) && /paid/.test(r)));
  const ledgerText = await text('[data-testid=ledger]');
  assert.match(ledgerText, /Free monthly credits/);
  assert.match(ledgerText, /Used/);
  assert.match(ledgerText, /Purchase/);
  assert.match(ledgerText, /Subscription/);
  await page.getByTestId('plan-pro').getByRole('button', { name: 'Current plan' }).waitFor();
  log('billing: balance, buy a pack, subscribe to a plan, credit history and purchase history (demo payments)');

  // a canceled demo checkout charges nothing
  await page.getByTestId('pack-pack_500').getByRole('button', { name: 'Buy pack' }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByText(/Checkout was canceled/).waitFor();
  assert.equal(await text('[data-testid=balance-total]'), '427');
  log('canceling checkout charges nothing');

  // ---------------------------------------------------------------- home cards + management
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  const card = page.locator('[data-testid=project-card]').first();
  await card.waitFor();
  assert.ok(await card.getByText('Ready').isVisible());
  await page.waitForFunction(() => { const i = document.querySelector('[data-testid=project-card] img'); return i && i.naturalWidth > 0; }, null, { timeout: 20_000 });
  await shot('07-home-cards');
  await card.getByRole('button', { name: 'Rename' }).click();
  await page.fill('#rename-input', 'Holiday video');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('[data-testid=project-card]', { hasText: 'Holiday video' }).waitFor();
  log('home shows recent projects as cards with a thumbnail and status; rename works');

  // ---------------------------------------------------------------- privacy: another account
  const other = await browser.newContext();
  const op = await other.newPage();
  watch(op, 'other ');
  await op.goto(`${server.base}/editor/${projectId}`);
  await op.waitForURL(/\/login/);
  await op.getByRole('link', { name: 'Create an account' }).click();
  await op.fill('#auth-email', 'other@example.com');
  await op.fill('#auth-password', 'another-pass-1');
  await op.getByRole('button', { name: 'Create account' }).click();
  await op.waitForURL(`${server.base}/editor/${projectId}`);
  await op.getByText('Could not open this project').waitFor();
  assert.equal((await op.request.get(`${server.base}/api/projects/${projectId}/video`)).status(), 404);
  await other.close();
  log("another account cannot open or stream someone else's project");

  // ---------------------------------------------------------------- low-credit notifications
  const lowServer = await startServer({ providers: fakeProviders('ok'), config: { billing: loadConfig({ FREE_MONTHLY_CREDITS: '6', LOW_CREDIT_THRESHOLD: '5' }).billing } });
  const lowCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const lp = await lowCtx.newPage();
  watch(lp, 'low ');
  await lp.goto(lowServer.base);
  await lp.getByRole('link', { name: 'Create an account' }).click();
  await lp.fill('#auth-email', 'low@example.com');
  await lp.fill('#auth-password', 'low-credit-pass1');
  await lp.getByRole('button', { name: 'Create account' }).click();
  await lp.getByText('No projects yet').waitFor();
  assert.equal(await lp.getByTestId('unread-count').count(), 0);
  const made = await (await lp.request.post(`${lowServer.base}/api/projects`, { headers: API, data: { sourceLanguage: 'en', targetLanguage: 'none' } })).json();
  const up = await lp.request.put(`${lowServer.base}/api/projects/${made.project.id}/video`, { headers: { ...API, 'X-File-Name': 'clip.webm', 'Content-Type': 'video/webm' }, data: readFileSync(videoPath) });
  assert.equal(up.status(), 200);
  assert.equal((await lp.request.post(`${lowServer.base}/api/projects/${made.project.id}/transcribe`, { headers: API, data: {} })).status(), 202);
  await lp.waitForTimeout(2500);
  await lp.reload();
  await lp.getByTestId('unread-count').waitFor();
  assert.ok((await lp.locator('.credit-pill').getAttribute('class')).includes('is-low'));
  await lp.getByRole('button', { name: /Notifications/ }).click();
  await lp.getByText('Credits are running low').waitFor();
  await shot('08-low-credit', lp);
  await lp.reload();
  assert.equal(await lp.getByTestId('unread-count').count(), 0, 'opening the bell marks them read');
  await lowCtx.close();
  await lowServer.close();
  log('low-credit warning: credit pill turns amber and a notification appears once');

  // ---------------------------------------------------------------- mobile layout
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const login = await mobile.request.post(`${server.base}/api/auth/login`, { headers: API, data: { email: 'maya@example.com', password: 'correct-horse-9' } });
  assert.equal(login.status(), 200);
  const mp = await mobile.newPage();
  watch(mp, 'mobile ');
  for (const url of ['/', '/new', '/billing', `/editor/${projectId}`, `/export/${projectId}`, '/login']) {
    await mp.goto(server.base + url);
    await mp.waitForLoadState('networkidle');
    await mp.waitForTimeout(500);
    const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `${url} overflows horizontally by ${overflow}px on a 390px screen`);
    if (shots) await mp.screenshot({ path: path.join(shots, `mobile-${url === '/' ? 'home' : url.split('/')[1] || 'x'}.png`), fullPage: true });
  }
  await mobile.close();
  log('mobile (390px): home, wizard, billing, editor, export have no horizontal overflow');

  // ---------------------------------------------------------------- delete + unknown route
  await page.goto(server.base);
  const target = page.locator('[data-testid=project-card]', { hasText: 'Holiday video' });
  await target.getByRole('button', { name: 'Delete' }).click();
  await page.getByText(/permanently deleted/).waitFor();
  await page.getByRole('button', { name: 'Delete project' }).click();
  await target.waitFor({ state: 'detached' });
  assert.equal((await page.request.get(`${server.base}/api/projects/${projectId}`)).status(), 404);
  await page.goto(`${server.base}/nope/nothing`);
  await page.getByText('Page not found').waitFor();
  log('delete with confirmation; unknown routes show a friendly page');

  assert.deepEqual(problems, [], `browser errors:\n${problems.join('\n')}`);
  log('no unexpected console or page errors in the whole run');
  console.log(`\nE2E PASSED (${step} checks)`);
} catch (error) {
  console.error('\nE2E FAILED:', error);
  if (shots) await page.screenshot({ path: path.join(shots, 'failure.png'), fullPage: true }).catch(() => undefined);
  console.error('URL at failure:', page.url());
  if (problems.length) console.error('Browser errors so far:\n' + problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
