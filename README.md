# Subly AI

Sign up, create a project, upload a video (and an optional voice-over), trim it, pick the languages, let AI write synchronized subtitles, edit them on a timeline, style them, and export SRT / VTT / TXT or a video with the subtitles burned in. Accounts, monthly free credits, plans, credit packs, purchase history and low-credit notifications are built in.

- **Frontend:** React 19 + TypeScript + Vite (`client/`), dark charcoal theme with purple/blue accents, responsive
- **Backend:** Node.js 22 + TypeScript on Node's own `http` module (`server/`), no Express, no runtime npm dependencies
- **Database:** SQLite through Node's built-in `node:sqlite` (accounts, sessions, credit ledger, payments, notifications). Videos and subtitles stay as files under `data/`
- **Media:** FFmpeg / ffprobe (trim, voice-over mix, thumbnails, waveform, burned-in subtitles)
- **AI:** [OpenRouter](https://openrouter.ai): Whisper for speech-to-text, a free chat model for translation, behind a provider interface (`server/src/services/providers/`)
- **Payments:** Stripe Checkout (real, needs your Stripe account) or a **demo mode** with a fake checkout (no real money)

## What needs keys / accounts, and what does not

| Feature | Needs | Status |
|---|---|---|
| Sign up / sign in, projects, upload, trim, voice-over, timeline editor, styles, autosave, SRT/VTT/TXT, burned-in video, credits, demo purchases | nothing (FFmpeg only) | implemented and tested |
| **Speech-to-text** | `OPENROUTER_API_KEY` **and paid OpenRouter credit** (OpenRouter has no free speech-to-text) | implemented; tested against fake providers and a local mock server only |
| **Translation** | `OPENROUTER_API_KEY` (free default model, rate limited) | same as above |
| **Real payments** | Stripe account: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PUBLIC_URL` | implemented; tested against a **local mock of Stripe** only, never the real service |
| E-mail (verification, password reset, e-mail notifications) | an e-mail service | **not implemented** |

## Requirements

| Requirement | Version | Notes |
|---|---|---|
| Node.js | **22.18 or newer** | runs TypeScript directly; `node:sqlite` is built in (prints no warning because the scripts pass `--disable-warning=ExperimentalWarning`) |
| FFmpeg + ffprobe | 5+ with `libx264` and `libass` | required for uploads (ffprobe validates files), trim, thumbnails and burned-in video |

## Run it locally

```bash
npm install
cp .env.example .env        # add OPENROUTER_API_KEY if you have one
npm run build               # builds the frontend into client/dist
npm start                   # http://127.0.0.1:3000
```

The console tells you whether transcription, translation, burned-in video and payments are available, and warns loudly when payments are in demo mode.

## Import and run on Replit (step by step)

> The `.replit` file in this project was written from Replit's documented format but **has not been tried on a live Replit account**. If a step behaves differently, the fallback is noted.

1. **Import:** Replit → *Create App* → *Import code* → *Upload* the ZIP (or create an empty **Node.js** Repl, then drag the unzipped folder contents into the file tree, so that `package.json` is at the top level).
2. **Node version:** this app needs Node 22.18+. `.replit` asks for the `nodejs-22` module. In the Shell run `node -v`. If it shows less than 22.18, open *Tools → Replit modules / Dependencies* (or edit `.replit` → `modules`) and choose a Node 22 module, then restart the Repl.
3. **FFmpeg:** `.replit` lists `ffmpeg-full` in `[nix] packages`. Check in the Shell: `ffmpeg -version` and `ffmpeg -filters | grep subtitles`. If it is missing, open *Tools → System dependencies* and add `ffmpeg-full`.
4. **Install:** in the Shell run `npm install`.
5. **Secrets** (padlock icon *Tools → Secrets*, never paste keys in chat or commit them). Add:
   - `OPENROUTER_API_KEY` — from <https://openrouter.ai/keys>. Add a few dollars of credit on OpenRouter for speech-to-text.
   - `PUBLIC_URL` — your Repl's public https address (shown in the Webview), e.g. `https://my-app.username.repl.co`.
   - Payments: leave `PAYMENTS_MODE` unset to test with the **demo** checkout. For real payments add `STRIPE_SECRET_KEY` (start with a `sk_test_` key) and `STRIPE_WEBHOOK_SECRET`, and set `PAYMENTS_MODE=stripe` (see Stripe section).
6. **Run:** press **Run**. It builds the frontend, then starts the server on port 3000 (`HOST=0.0.0.0` is set in `.replit`). The Webview opens the app.
7. **Persistence:** the `data/` folder (database + videos) lives in the Repl's disk. A Replit *Deployment* may use a fresh disk on each publish, so it can lose accounts and projects: keep `DATA_DIR` on persistent storage before relying on a deployment.

## Test every major feature (manual checklist)

Do this once after starting the app. Items marked **(needs key)** only work with the keys above.

1. **Accounts:** open the app → you are sent to *Sign in* → *Create an account* → you land on Home with **30 credits**. Sign out and back in. A wrong password is refused.
2. **Home:** empty state first; after step 3, your project shows as a **card** (thumbnail, status). Use the round **+** button (bottom right) to start a project. Rename and Delete (with confirmation) are on the card.
3. **New project:** choose a video (MP4/MOV/WebM/MKV/AVI) → a **preview with trim sliders** appears (also "Set start/end to playhead"). Optionally add a **voice-over** (MP3/WAV/M4A/…). Press **Continue**: the server cuts the video and mixes in the voice-over, then opens language selection.
4. **Languages:** pick the video's language (or *Auto detect*) and the subtitle language. The **credit price is shown before** you start. Same language twice is refused.
5. **Generate (needs key):** *Generate subtitles* shows progress, then the editor. Without a key, press *Skip AI, open editor*. Credits are charged up front and **refunded if the job fails**.
6. **Editor:** the player shows subtitles over the video; below it the **video timeline** (thumbnails + waveform) and the **subtitle timeline** (one block per caption with timestamps). Click the timeline to seek. **Drag** a caption to move it, drag its **edges** to resize it, or focus it and press ←/→ (Shift = bigger step, Ctrl = end only). Edit text/start/end in the form (invalid times are refused); add, delete, split, merge, search, undo/redo; zoom the timeline.
7. **Customization:** presets (Classic, Bold pop, Boxed, Cinematic, Neon, Minimal top) and font family, size, colour, background + opacity, bold, italic, alignment, position. The preview updates live.
8. **Save / autosave:** *Save project* saves now; *Autosave* (toggle) saves a moment after each change. Reload the page: everything is still there.
9. **Export:** *Export* page → SRT, VTT, TXT (free, generated in the browser). *Burned-in video* renders on the server (**1 credit** per started 5 minutes by default) and downloads as MP4.
10. **Credits & billing:** the credit pill shows your balance; *Credits* page shows balance, plans, packs, **credit history** and **purchase history**. In demo mode, buy a pack or subscribe → fake checkout page → pay or cancel. When the balance drops to 5 or fewer, the pill turns amber and a **notification** (bell) appears once.
11. **Privacy:** open a project URL while signed in as a different account → "Could not open this project".

Automated checks (run by the author, results below): `npm test` and `npm run test:e2e`.

## Credits

- Every account gets `FREE_MONTHLY_CREDITS` (default 30) at the start of each UTC month. **Unused free credits expire** at month end. Bought and subscription credits never expire. Spending uses free credits first.
- Default prices: transcription 1 credit per started minute, translation 1 credit per 2 started minutes, burned-in video 1 credit per 5 started minutes. Trim, voice-over, editing and SRT/VTT/TXT export are free.
- Every change is a row in the credit ledger (written in the same database transaction as the balance). If a paid task fails or is interrupted by a restart, its credits are refunded once.
- Plans and packs live in `server/src/services/billing.ts` (`CATALOG`): **example prices**, change them before going live.

## Payments

`PAYMENTS_MODE`:

- `demo` (default without Stripe keys): a fake checkout page; **no real money moves, and anyone can "buy" credits for free**. For testing only. Never run demo mode on a public site.
- `stripe`: real Stripe Checkout. Needs `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and an https `PUBLIC_URL`; without them the server falls back to `off` and says why.
- `off`: purchases disabled.

Stripe setup: in the Stripe dashboard (test mode first) create a webhook endpoint `PUBLIC_URL/api/billing/webhook` with events `checkout.session.completed`, `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted`, `checkout.session.expired`; copy its signing secret into `STRIPE_WEBHOOK_SECRET`. Test with Stripe's test card `4242 4242 4242 4242`. Credits are only granted from **signature-verified webhooks** (each event and each payment is processed once). Subscriptions are managed (change/cancel) in Stripe's customer portal through *Manage subscription*.

**Not verified:** the Stripe code follows Stripe's documented API but was only exercised against a local mock. Test the full flow with Stripe test keys before accepting real payments.

## Configure the AI provider (OpenRouter)

1. Create a key at <https://openrouter.ai/keys> and set `OPENROUTER_API_KEY`. It stays on the server.
2. Optional: `TRANSLATION_MODEL` (default `openrouter/free`), `TRANSCRIPTION_MODEL` (default `openai/whisper-large-v3-turbo`).
3. Speech-to-text is billed per audio second by OpenRouter (roughly $0.000003/s for the default model at the time of writing; check the live price). Translation is free with the default model but rate limited.
4. Audio longer than `TRANSCRIPTION_CHUNK_MINUTES` (10) is sent in pieces; check subtitles around multiples of 10 minutes.
5. Audio and subtitle text are sent to OpenRouter and the model provider behind it. Check their data policies before processing private videos.

## API

All routes are under `/api`; errors look like `{ "error": { "code", "message" } }`. Sign-in uses an HttpOnly session cookie; every state-changing request must send the header `X-Requested-With: subly` (CSRF defence).

| Area | Routes |
|---|---|
| Health/config | `GET /api/health`, `GET /api/config` |
| Auth | `POST /api/auth/register`, `/login`, `/logout`, `/password`; `GET /api/auth/me` |
| Projects | `GET/POST /api/projects`; `GET/PUT/DELETE /api/projects/:id`; `PUT /api/projects/:id/video`; `PUT/DELETE /api/projects/:id/voiceover`; `POST /api/projects/:id/prepare` (trim + voice-over); `GET /api/projects/:id/estimate`; `GET /api/projects/:id/video`; `GET /api/projects/:id/assets/{poster,strip,waveform}` |
| AI | `POST /api/projects/:id/transcribe`, `/translate` |
| Export | `POST/GET /api/projects/:id/render`, `GET /api/projects/:id/render/file` |
| Billing | `GET /api/billing`, `/billing/ledger`, `/billing/payments`; `POST /api/billing/checkout`, `/billing/portal`, `/billing/webhook`; demo: `GET/POST /api/billing/demo/:id[/pay\|/cancel]`, `POST /api/billing/demo-cancel-subscription` |
| Notifications | `GET /api/notifications`, `POST /api/notifications/read` |

## Code layout

```
client/src/        React app: pages/ (Home, NewProject, Editor, Export, Billing, Auth, DemoCheckout), components/ (TimelinePanel, TrimPreview, StylePanel, …), lib/ (api, auth, router)
server/src/        app.ts (wiring), routes.ts + routes/{auth,billing}.ts, session.ts
server/src/services/  db, auth, credits, notifications, billing, payments/stripe, pipeline (AI jobs, trim), render, assets, store, ffmpeg
shared/            subtitles.js, style.js (presets), credits.js (prices): used by both browser and server
tests/             unit/, api/ (Node test runner), e2e/ (Playwright)
```

## Tests

```bash
npm test             # unit + API tests (accounts, credits, refunds, billing, Stripe mock, trim, ownership, …)
npm run typecheck    # TypeScript for server and client (needs npm install)
npm run build && npm i --no-save playwright && npx playwright install chromium
npm run test:e2e     # drives the real UI in Chromium (E2E_SHOTS=/dir keeps screenshots)
```

Tests use fake AI providers and a mock Stripe server: they do **not** prove that your OpenRouter key/credit or your Stripe account work.

## Security notes

Passwords are hashed with scrypt; sessions are random tokens stored only as SHA-256 hashes; cookies are HttpOnly + SameSite=Lax (+ Secure on https); state-changing requests need the CSRF header; sign-in is rate limited; projects are only reachable by their owner (other accounts get "not found"); uploads are verified by content with ffprobe; Stripe webhooks are signature-verified; secrets only come from environment variables.

## Known limitations

- **No e-mail:** no e-mail verification, password reset or e-mail notifications. Notifications are in-app only. Anyone can create accounts, so free monthly credits can be farmed with many accounts: add e-mail verification/CAPTCHA before a public launch.
- Projects created with the old (token-based, version 1) app are not visible in the new account system.
- Trim and voice-over permanently change the stored video and are only allowed before subtitles exist. The voice-over starts at the start of the trimmed video (padded with silence / cut at the end).
- Single server process, SQLite and local files: fine for one machine, not for several servers without moving to a shared database/storage.
- Subscription renewals in demo mode are not simulated (a plan is a one-time grant there).
- Browsers cannot play every codec; the server makes a playable copy when needed. Burned-in rendering uses fonts installed on the server.
- Translation quality varies by language; free models are rate limited and weaker. Always review.
- Transcription pieces (10 min) can split or repeat a word at a boundary.
- The client typecheck in the author's sandbox used a minimal React type shim because the npm registry was unreachable: run `npm run typecheck` yourself.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `node: bad option` / TypeScript syntax errors on start | Node is older than 22.18: upgrade |
| "ffprobe not found" / uploads fail | install FFmpeg or set `FFMPEG_PATH` / `FFPROBE_PATH` |
| Blank page at `/` | run `npm run build` first |
| Transcription says not configured / no credit | set `OPENROUTER_API_KEY`; add credit on openrouter.ai |
| "busy or rate limit" when translating | wait and retry, or set another `TRANSLATION_MODEL` |
| Payments say "not set up" | set the three Stripe values + https `PUBLIC_URL`, or use demo mode while testing |
| Stripe purchase done but no credits | the webhook is not reaching `PUBLIC_URL/api/billing/webhook` or `STRIPE_WEBHOOK_SECRET` is wrong |
| Signed out after restart on a deployment | the disk was reset: put `DATA_DIR` on persistent storage |
| Burned-in video unavailable | your FFmpeg lacks `libass`/`libx264` |
