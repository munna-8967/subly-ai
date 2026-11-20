import { rm } from 'node:fs/promises';
import path from 'node:path';
import {
  roundMs,
  sanitizeFileName,
  sortSubtitles,
  validateSubtitle,
  validateSubtitles,
} from '../../shared/subtitles.js';
import { normalizeStyle } from '../../shared/style.js';
import { LANGUAGES, findLanguage } from './config/languages.ts';
import type { Config } from './config.ts';
import { AppError } from './errors.ts';
import { readJsonBody, sendFile, sendJson, sendNoContent } from './http.ts';
import type { Ctx, Router } from './http.ts';
import { Pipeline } from './services/pipeline.ts';
import type { Providers } from './services/providers/types.ts';
import { RenderManager } from './services/render.ts';
import { isProjectId, newProjectId, ProjectStore } from './services/store.ts';
import type { AssetService } from './services/assets.ts';
import type { AuthService } from './services/auth.ts';
import type { BillingService } from './services/billing.ts';
import type { CreditsService } from './services/credits.ts';
import type { Db } from './services/db.ts';
import type { NotificationService } from './services/notifications.ts';
import { requireUser } from './session.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerBillingRoutes } from './routes/billing.ts';
import { ALLOWED_EXTENSIONS, receiveVideo, receiveVoiceover, VOICEOVER_EXTENSIONS } from './upload.ts';
import { generationCost } from '../../shared/credits.js';
import type { ProjectRecord, ProjectStatus, Subtitle, SubtitleStyle } from './types.ts';

export interface Deps {
  config: Config;
  store: ProjectStore;
  pipeline: Pipeline;
  renders: RenderManager;
  providers: Providers;
  db: Db;
  auth: AuthService;
  credits: CreditsService;
  billing: BillingService;
  notifications: NotificationService;
  assets: AssetService;
}

const APP_VERSION = '2.0.0';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeStatus(record: ProjectRecord): ProjectStatus {
  if (!record.media) return 'empty';
  if (record.job?.state === 'running') return 'processing';
  if (record.subtitles.length > 0) return 'ready';
  if (record.job?.state === 'failed') return 'failed';
  return 'draft';
}

/** The project as sent to the browser. Never includes the token hash or file names. */
function toPublic(record: ProjectRecord, deps: Deps, summary: boolean) {
  const media = record.media;
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: computeStatus(record),
    sourceLanguage: record.sourceLanguage,
    targetLanguage: record.targetLanguage,
    detectedLanguage: record.detectedLanguage ?? null,
    style: record.style,
    job: record.job ? (({ charges: _c, ...rest }) => rest)(record.job) : null,
    render: deps.renders.view(record),
    subtitleCount: record.subtitles.length,
    media: media
      ? {
          originalName: media.originalName,
          mimeType: media.mimeType,
          size: media.size,
          duration: media.duration,
          width: media.width,
          height: media.height,
          hasAudio: media.hasAudio,
          preview: { state: media.preview.state, error: media.preview.error ?? null },
          voiceover: media.voiceover ? { originalName: media.voiceover.originalName, duration: media.voiceover.duration, size: media.voiceover.size } : null,
          prepared: media.prepared === true,
        }
      : null,
    ...(summary ? {} : { subtitles: record.subtitles }),
  };
}

/**
 * Load a project and check the signed-in user owns it. Unknown ids and other people's projects give
 * the same 404 so ids cannot be probed. Media <video>/<img>/<a> requests carry the session cookie.
 */
async function requireProject(ctx: Ctx, deps: Deps): Promise<ProjectRecord> {
  const user = requireUser(ctx, deps.auth);
  const notFound = new AppError(404, 'project_not_found', 'Project not found, or you do not have access to it.');
  const id = ctx.params.id;
  if (!isProjectId(id)) throw notFound;
  const record = await deps.store.get(id);
  if (!record || record.ownerId !== user.id) throw notFound;
  return record;
}

function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(400, 'validation_error', 'The request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

function validationError(message: string, details?: unknown): AppError {
  return new AppError(400, 'validation_error', message, details);
}

function parseName(value: unknown): string {
  if (typeof value !== 'string') throw validationError('Project name must be text.');
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  if (name.length === 0 || name.length > 120) throw validationError('Project name must be 1-120 characters.');
  return name;
}

function parseSource(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw validationError('Choose the language spoken in the video (or Auto detect).');
  if (value === 'auto') return value;
  if (!findLanguage(value) || findLanguage(value)?.code !== value) throw validationError('The video language is not supported.');
  return value;
}

function parseTarget(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw validationError('Choose the language for the subtitles.');
  if (value === 'none') return value;
  if (!findLanguage(value) || findLanguage(value)?.code !== value) throw validationError('The subtitle language is not supported.');
  return value;
}

function checkLanguagePair(source: string, target: string): void {
  if (source !== 'auto' && target !== 'none' && source === target) {
    throw validationError('The video and subtitle languages are the same. Choose a different subtitle language, or "No translation".');
  }
}

/** Validate + normalise a subtitle list from the browser. */
function parseSubtitles(value: unknown, duration: number | undefined): Subtitle[] {
  const result = validateSubtitles(value);
  if (!result.ok) {
    throw validationError('Some subtitles are invalid.', result.errors.slice(0, 20));
  }
  const cleaned: Subtitle[] = [];
  const problems: { index: number; id: string; message: string }[] = [];
  (value as Subtitle[]).forEach((sub, index) => {
    const rounded: Subtitle = { id: sub.id, start: roundMs(sub.start), end: roundMs(sub.end), text: sub.text.trim() };
    if (typeof sub.translation === 'string' && sub.translation.trim() !== '') rounded.translation = sub.translation.trim();
    for (const message of validateSubtitle(rounded, { duration })) problems.push({ index, id: sub.id, message });
    cleaned.push(rounded);
  });
  if (problems.length > 0) throw validationError('Some subtitles are invalid.', problems.slice(0, 20));
  return sortSubtitles(cleaned);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerRoutes(router: Router, deps: Deps): void {
  const { config, store, pipeline, renders, providers } = deps;

  router.add('GET', '/api/health', (ctx) => {
    sendJson(ctx.res, 200, { ok: true });
  });

  registerAuthRoutes(router, deps);
  registerBillingRoutes(router, deps);

  // What the browser needs to build its forms and explain limits.
  router.add('GET', '/api/config', (ctx) => {
    const { transcription, translation } = providers;
    sendJson(ctx.res, 200, {
      app: { name: 'Subly AI', version: APP_VERSION },
      limits: {
        maxUploadBytes: config.maxUploadBytes,
        maxDurationSeconds: config.maxDurationSeconds,
        allowedExtensions: ALLOWED_EXTENSIONS,
        maxSubtitles: 5000,
      },
      languages: LANGUAGES,
      providers: {
        transcription: {
          id: transcription.id,
          name: transcription.name,
          configured: transcription.isConfigured(),
          maxDurationSeconds: transcription.maxAudioSeconds,
          note: transcription.note,
        },
        translation: {
          id: translation.id,
          name: translation.name,
          configured: translation.isConfigured(),
          note: translation.note,
        },
      },
      credits: { costs: config.billing.costs, freeMonthly: config.billing.freeMonthlyCredits, paymentsMode: config.billing.paymentsMode, lowThreshold: config.billing.lowCreditThreshold },
      voiceoverExtensions: VOICEOVER_EXTENSIONS,
      render: {
        available: renders.support.available,
        reason: renders.support.reason ?? null,
        retentionHours: config.renderRetentionHours,
      },
    });
  });

  // Recent projects for the home screen (newest activity first).
  router.add('GET', '/api/projects', async (ctx) => {
    const user = requireUser(ctx, deps.auth);
    const rows = deps.db.all<{ id: string }>('SELECT id FROM projects WHERE owner_id = ? ORDER BY created_at DESC LIMIT 200', user.id);
    const records = (await Promise.all(rows.map((r) => store.get(r.id)))).filter((r): r is ProjectRecord => r !== null && r.ownerId === user.id);
    records.sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
    sendJson(ctx.res, 200, { projects: records.map((r) => toPublic(r, deps, true)) });
  });

  // Step 1 of a new project. Languages are chosen later (step 3), so they are optional here.
  router.add(
    'POST',
    '/api/projects',
    async (ctx) => {
      const user = requireUser(ctx, deps.auth);
      const body = asObject(await readJsonBody(ctx.req, 16 * 1024));
      const sourceLanguage = body.sourceLanguage === undefined ? 'auto' : parseSource(body.sourceLanguage);
      const targetLanguage = body.targetLanguage === undefined ? 'none' : parseTarget(body.targetLanguage);
      checkLanguagePair(sourceLanguage, targetLanguage);
      const name = body.name === undefined || body.name === '' ? '' : parseName(body.name);

      const style = normalizeStyle(undefined);
      if (!style.ok) throw new Error('default style is invalid');
      const now = new Date().toISOString();
      const record: ProjectRecord = {
        id: newProjectId(),
        name,
        createdAt: now,
        updatedAt: now,
        ownerId: user.id,
        sourceLanguage,
        targetLanguage,
        media: null,
        subtitles: [],
        style: style.style,
        job: null,
        render: null,
      };
      await store.create(record);
      deps.db.run('INSERT INTO projects (id, owner_id, created_at) VALUES (?, ?, ?)', record.id, user.id, now);
      sendJson(ctx.res, 201, { project: toPublic(record, deps, false) });
    },
    'heavy',
  );

  // Step 2: upload the video as the raw request body (XHR shows real progress).
  router.add(
    'PUT',
    '/api/projects/:id/video',
    async (ctx) => {
      const record = await requireProject(ctx, deps);
      if (record.media) throw new AppError(409, 'video_exists', 'This project already has a video.');
      pipeline.beginUpload(record.id);
      try {
        const media = await receiveVideo(config, store, ctx.req, record.id);
        const updated = await store.update(record.id, (r) => {
          if (r.media) throw new AppError(409, 'video_exists', 'This project already has a video.');
          r.media = media;
          if (!r.name) r.name = media.originalName.replace(/\.[^.]+$/, '').slice(0, 120) || 'Untitled project';
        });
        if (media.preview.state === 'processing') pipeline.startPreview(record.id);
        sendJson(ctx.res, 200, { project: toPublic(updated, deps, false) });
      } finally {
        pipeline.endUpload(record.id);
      }
    },
    'heavy',
  );

  router.add('GET', '/api/projects/:id', async (ctx) => {
    const record = await requireProject(ctx, deps);
    sendJson(ctx.res, 200, { project: toPublic(record, deps, ctx.url.searchParams.get('summary') === '1') });
  });

  // Save edits: name, subtitles, style, languages.
  router.add('PUT', '/api/projects/:id', async (ctx) => {
    const record = await requireProject(ctx, deps);
    const body = asObject(await readJsonBody(ctx.req, 8 * 1024 * 1024));

    if (body.subtitles !== undefined && pipeline.isJobRunning(record.id)) {
      throw new AppError(409, 'project_busy', 'An AI task is running for this project. Wait for it to finish before saving subtitles.');
    }
    const name = body.name !== undefined ? parseName(body.name) : undefined;
    const subtitles = body.subtitles !== undefined ? parseSubtitles(body.subtitles, record.media?.duration) : undefined;
    let style: SubtitleStyle | undefined;
    if (body.style !== undefined) {
      const normalized = normalizeStyle(body.style);
      if (!normalized.ok) throw validationError('Invalid subtitle style.', normalized.errors);
      style = normalized.style;
    }
    const sourceLanguage = body.sourceLanguage !== undefined ? parseSource(body.sourceLanguage) : undefined;
    const targetLanguage = body.targetLanguage !== undefined ? parseTarget(body.targetLanguage) : undefined;
    checkLanguagePair(sourceLanguage ?? record.sourceLanguage, targetLanguage ?? record.targetLanguage);

    const updated = await store.update(record.id, (r) => {
      if (name !== undefined) r.name = name;
      if (subtitles !== undefined) r.subtitles = subtitles;
      if (style !== undefined) r.style = style;
      if (sourceLanguage !== undefined) r.sourceLanguage = sourceLanguage;
      if (targetLanguage !== undefined) r.targetLanguage = targetLanguage;
    });
    sendJson(ctx.res, 200, { project: toPublic(updated, deps, false) });
  });

  router.add('DELETE', '/api/projects/:id', async (ctx) => {
    const record = await requireProject(ctx, deps);
    pipeline.cancelAll(record.id);
    renders.cancel(record.id);
    await store.delete(record.id);
    deps.db.run('DELETE FROM projects WHERE id = ?', record.id);
    sendNoContent(ctx.res);
  });

  // The video for the editor's player (Range requests supported for seeking).
  router.add('GET', '/api/projects/:id/video', async (ctx) => {
    const record = await requireProject(ctx, deps);
    const media = record.media;
    if (!media) throw new AppError(404, 'no_video', 'This project has no video yet.');
    const preview = media.preview;
    if (preview.state === 'processing') {
      throw new AppError(409, 'preview_not_ready', 'The video preview is still being prepared.');
    }
    if (preview.state === 'failed') throw new AppError(422, 'preview_failed', preview.error ?? 'No playable preview is available.');
    const file = preview.state === 'ready' && preview.storedName ? preview.storedName : media.storedName;
    await sendFile(ctx.req, ctx.res, path.join(store.projectDir(record.id), file), {
      contentType: preview.state === 'ready' ? 'video/mp4' : media.mimeType,
    });
  });

  router.add(
    'POST',
    '/api/projects/:id/transcribe',
    async (ctx) => {
      const record = await requireProject(ctx, deps);
      const body = asObject(await readJsonBody(ctx.req, 4 * 1024));
      const updated = await pipeline.startTranscription(record, { overwrite: body.overwrite === true });
      sendJson(ctx.res, 202, { project: toPublic(updated, deps, true) });
    },
    'heavy',
  );

  router.add(
    'POST',
    '/api/projects/:id/translate',
    async (ctx) => {
      const record = await requireProject(ctx, deps);
      const body = asObject(await readJsonBody(ctx.req, 4 * 1024));
      const target = body.targetLanguage !== undefined ? parseTarget(body.targetLanguage) : record.targetLanguage;
      if (target === 'none') throw validationError('Choose a target language to translate into.');
      const updated = await pipeline.startTranslation(record, { targetLanguage: target, overwrite: body.overwrite === true });
      sendJson(ctx.res, 202, { project: toPublic(updated, deps, true) });
    },
    'heavy',
  );

  // Burned-in video (separate from subtitle FILE export, which happens in the browser).
  router.add(
    'POST',
    '/api/projects/:id/render',
    async (ctx) => {
      const record = await requireProject(ctx, deps);
      const body = asObject(await readJsonBody(ctx.req, 4 * 1024));
      if (body.track !== undefined && body.track !== 'original' && body.track !== 'translation') {
        throw validationError('track must be "original" or "translation".');
      }
      const render = await renders.start(record, body.track === 'translation' ? 'translation' : 'original');
      sendJson(ctx.res, 202, { render });
    },
    'heavy',
  );

  router.add('GET', '/api/projects/:id/render', async (ctx) => {
    const record = await requireProject(ctx, deps);
    sendJson(ctx.res, 200, { render: renders.view(record) });
  });

  router.add('GET', '/api/projects/:id/render/file', async (ctx) => {
    const record = await requireProject(ctx, deps);
    if (record.render?.state !== 'succeeded') {
      throw new AppError(404, 'render_not_ready', record.render?.state === 'expired' ? 'This render has expired. Start a new one.' : 'There is no finished render to download.');
    }
    const base = sanitizeFileName(record.name, 'video');
    await sendFile(ctx.req, ctx.res, store.renderPath(record.id), {
      contentType: 'video/mp4',
      downloadName: `${base}-subtitled.mp4`,
    });
  });

  // Optional voice-over audio (raw body). It is applied in the "prepare" step.
  router.add(
    'PUT',
    '/api/projects/:id/voiceover',
    async (ctx) => {
      const record = await requireProject(ctx, deps);
      if (!record.media) throw new AppError(422, 'no_video', 'Upload the video first.');
      if (record.subtitles.length > 0) throw new AppError(409, 'subtitles_exist', 'A voice-over can only be added before subtitles are created.');
      pipeline.beginUpload(`vo:${record.id}`);
      try {
        const voiceover = await receiveVoiceover(config, store, ctx.req, record.id);
        const updated = await store.update(record.id, (r) => {
          if (r.media) r.media.voiceover = voiceover;
        });
        sendJson(ctx.res, 200, { project: toPublic(updated, deps, true) });
      } finally {
        pipeline.endUpload(`vo:${record.id}`);
      }
    },
    'heavy',
  );

  router.add('DELETE', '/api/projects/:id/voiceover', async (ctx) => {
    const record = await requireProject(ctx, deps);
    const stored = record.media?.voiceover?.storedName;
    const updated = await store.update(record.id, (r) => {
      if (r.media) delete r.media.voiceover;
    });
    if (stored) await rm(path.join(store.projectDir(record.id), stored), { force: true });
    sendJson(ctx.res, 200, { project: toPublic(updated, deps, true) });
  });

  // Apply trim and/or voice-over to the stored video (background job, free of charge).
  router.add(
    'POST',
    '/api/projects/:id/prepare',
    async (ctx) => {
      const record = await requireProject(ctx, deps);
      const body = asObject(await readJsonBody(ctx.req, 4 * 1024));
      const duration = record.media?.duration ?? 0;
      const trimStart = body.trimStart === undefined ? 0 : Number(body.trimStart);
      const trimEnd = body.trimEnd === undefined ? duration : Number(body.trimEnd);
      if (!Number.isFinite(trimStart) || !Number.isFinite(trimEnd)) throw validationError('The trim range must be numbers.');
      const updated = await pipeline.startPrepare(record, { trimStart, trimEnd, useVoiceover: body.useVoiceover === true });
      sendJson(ctx.res, 202, { project: toPublic(updated, deps, true) });
    },
    'heavy',
  );

  // Credit price of "generate subtitles" for this project (so the browser can show it before starting).
  router.add('GET', '/api/projects/:id/estimate', async (ctx) => {
    const record = await requireProject(ctx, deps);
    if (!record.media) throw new AppError(422, 'no_video', 'Upload a video first.');
    const target = ctx.url.searchParams.get('target') ?? record.targetLanguage;
    const withTranslation = target !== 'none' && target !== '';
    sendJson(ctx.res, 200, { credits: generationCost(record.media.duration, withTranslation, config.billing.costs), balance: deps.credits.balance(record.ownerId).total });
  });

  // Timeline pictures: poster frame, thumbnail strip, audio waveform (cookie-authenticated <img> requests).
  router.add('GET', '/api/projects/:id/assets/:kind', async (ctx) => {
    const record = await requireProject(ctx, deps);
    const kind = ctx.params.kind;
    if (kind !== 'poster' && kind !== 'strip' && kind !== 'waveform') throw new AppError(404, 'not_found', 'Unknown asset.');
    if (!record.media) throw new AppError(404, 'no_video', 'This project has no video yet.');
    if (kind === 'waveform' && !record.media.hasAudio) throw new AppError(404, 'no_audio', 'This video has no audio track.');
    let file: string;
    try {
      file = await deps.assets.get(record, kind);
    } catch {
      throw new AppError(422, 'asset_failed', 'The picture could not be created for this video.');
    }
    await sendFile(ctx.req, ctx.res, file, { contentType: kind === 'waveform' ? 'image/png' : 'image/jpeg' });
  });
}
