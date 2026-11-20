import { mkdtemp, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { generationCost, translateCost, transcribeCost } from '../../../shared/credits.js';
import { hasTranslation } from '../../../shared/subtitles.js';
import { findLanguage } from '../config/languages.ts';
import type { Config } from '../config.ts';
import { AppError, isAppError } from '../errors.ts';
import type { CreditsService } from './credits.ts';
import type { AssetService } from './assets.ts';
import { extractAudio, makePreview, probe, runFfmpeg } from './ffmpeg.ts';
import { ProviderError } from './providers/types.ts';
import type { Providers } from './providers/types.ts';
import { segmentsToSubtitles } from './segments.ts';
import type { ProjectStore } from './store.ts';
import type { JobState, JobType, ProjectRecord } from '../types.ts';

const TRANSLATE_BATCH = 40;

/** Is the target language the same as what was spoken (so translating would be pointless)? */
export function isSameLanguage(record: ProjectRecord, targetCode: string): boolean {
  const target = findLanguage(targetCode);
  if (!target) return false;
  if (record.sourceLanguage !== 'auto') return record.sourceLanguage === target.code;
  const detected = (record.detectedLanguage ?? '').trim().toLowerCase();
  return detected !== '' && (detected === target.name.toLowerCase() || detected === target.code);
}

function safeMessage(error: unknown): string {
  if (isAppError(error) || error instanceof ProviderError) return error.message;
  console.error('[pipeline] unexpected error:', error);
  return 'Something went wrong on the server. Please try again.';
}

/**
 * Background work for a project: speech-to-text, translation and preview creation.
 * Work runs after the HTTP request has been answered; progress is stored on the
 * project (`job`) and the browser polls for it.
 */
export class Pipeline {
  private config: Config;
  private store: ProjectStore;
  private providers: Providers;
  private credits: CreditsService;
  private assets: AssetService;
  /** one entry per project that has a transcription/translation or preview job running */
  private controllers = new Map<string, AbortController>();
  private uploading = new Set<string>();
  private previewQueue: Promise<unknown> = Promise.resolve();

  constructor(config: Config, store: ProjectStore, providers: Providers, credits: CreditsService, assets: AssetService) {
    this.config = config;
    this.store = store;
    this.providers = providers;
    this.credits = credits;
    this.assets = assets;
  }

  // -- bookkeeping ----------------------------------------------------------

  isJobRunning(id: string): boolean {
    return this.controllers.has(id);
  }

  beginUpload(id: string): void {
    if (this.uploading.has(id)) throw new AppError(409, 'upload_in_progress', 'A video is already being uploaded for this project.');
    this.uploading.add(id);
  }

  endUpload(id: string): void {
    this.uploading.delete(id);
  }

  /** Stop everything running for a project (used when it is deleted). */
  cancelAll(id: string): void {
    this.controllers.get(id)?.abort();
    this.controllers.get(`preview:${id}`)?.abort();
  }

  /** After a restart: fail jobs that were interrupted and resume preview creation. */
  async recover(): Promise<void> {
    for (const id of await this.store.listIds()) {
      const record = await this.store.get(id);
      if (!record) continue;
      const jobStuck = record.job?.state === 'running';
      const previewStuck = record.media?.preview.state === 'processing';
      if (jobStuck) {
        this.refundCharges(record.job?.charges, 'Refund: task interrupted by a server restart');
        await this.store.update(id, (r) => {
          if (r.job) {
            r.job.state = 'failed';
            r.job.error = 'This was interrupted by a server restart. Run it again.';
            r.job.updatedAt = new Date().toISOString();
          }
        });
      }
      if (previewStuck) this.startPreview(id);
    }
  }

  // -- transcription --------------------------------------------------------

  async startTranscription(record: ProjectRecord, options: { overwrite: boolean }): Promise<ProjectRecord> {
    const provider = this.providers.transcription;
    if (!provider.isConfigured()) {
      throw new AppError(
        503,
        'provider_not_configured',
        'AI transcription is not set up on this server. Add OPENROUTER_API_KEY to the server settings (.env, see README), or write subtitles manually in the editor.',
      );
    }
    const media = record.media;
    if (!media) throw new AppError(422, 'no_video', 'Upload a video first.');
    if (!media.hasAudio) throw new AppError(422, 'no_audio', 'This video has no audio track to transcribe.');
    if (media.duration > provider.maxAudioSeconds) {
      throw new AppError(
        422,
        'video_too_long',
        `This video is ${Math.round(media.duration / 60)} minutes long. ${provider.name} accepts up to ${Math.round(provider.maxAudioSeconds / 60)} minutes per video.`,
      );
    }
    if (record.subtitles.length > 0 && !options.overwrite) {
      throw new AppError(409, 'subtitles_exist', 'This project already has subtitles. Confirm to replace them with a new transcription.');
    }
    const withTranslation = record.targetLanguage !== 'none' && !isSameLanguage(record, record.targetLanguage);
    const costs = this.config.billing.costs;
    const charges: NonNullable<JobState['charges']> = {};
    const label = media.originalName.slice(0, 60);
    charges.transcribe = this.credits.spend(record.ownerId, transcribeCost(media.duration, costs), `Transcription: ${label}`, record.id);
    try {
      if (withTranslation) charges.translate = this.credits.spend(record.ownerId, translateCost(media.duration, costs), `Translation: ${label}`, record.id);
      return await this.begin(record.id, 'transcribe', 'extracting_audio', 'Extracting audio…', () => this.runTranscription(record.id), charges, generationCost(media.duration, withTranslation, costs));
    } catch (error) {
      this.refundCharges(charges, 'Refund: task could not start');
      throw error;
    }
  }

  private async runTranscription(id: string): Promise<void> {
    const signal = this.controllers.get(id)?.signal;
    const provider = this.providers.transcription;
    let tmp: string | undefined;
    try {
      tmp = await mkdtemp(path.join(this.store.tmpDir, 'tx-'));
      const record = await this.mustGet(id);
      const media = record.media as NonNullable<ProjectRecord['media']>;
      const audio = path.join(tmp, 'audio.mp3');

      await extractAudio(this.config, path.join(this.store.projectDir(id), media.storedName), audio, signal);
      if ((await stat(audio)).size > provider.maxAudioBytes) {
        throw new AppError(422, 'audio_too_large', 'The audio is too large for the transcription provider. Use a shorter video.');
      }

      await this.patchJob(id, { stage: 'transcribing', message: `Transcribing speech with ${provider.name}…` });
      const result = await provider.transcribe({
        audioPath: audio,
        language: record.sourceLanguage === 'auto' ? undefined : record.sourceLanguage,
        signal,
      });

      const subtitles = segmentsToSubtitles(result.segments);
      if (subtitles.length === 0) {
        throw new AppError(422, 'no_speech', 'No speech was detected in this video. You can add subtitles manually in the editor.');
      }
      const updated = await this.store.update(id, (r) => {
        r.subtitles = subtitles;
        if (result.language) r.detectedLanguage = result.language;
      });

      let warning: string | undefined;
      const charges = record.job?.charges;
      if (updated.targetLanguage !== 'none' && !isSameLanguage(updated, updated.targetLanguage)) {
        try {
          await this.translateMissing(id, updated.targetLanguage, true, signal);
        } catch (error) {
          // The transcript is already saved; a translation problem must not discard it.
          warning = `Subtitles were created, but translation failed (the translation credits were refunded): ${safeMessage(error)} You can retry it from the AI tab.`;
          this.refundCharges({ translate: charges?.translate }, 'Refund: translation failed');
        }
      } else {
        // Nothing to translate (same language as detected): give the translation credits back.
        this.refundCharges({ translate: charges?.translate }, 'Refund: no translation was needed');
      }
      await this.patchJob(id, { state: 'succeeded', stage: 'done', message: `Created ${subtitles.length} subtitles.`, warning });
    } catch (error) {
      await this.failJob(id, error);
    } finally {
      if (tmp) await rm(tmp, { recursive: true, force: true });
      this.controllers.delete(id);
    }
  }

  // -- translation ----------------------------------------------------------

  async startTranslation(record: ProjectRecord, options: { targetLanguage: string; overwrite: boolean }): Promise<ProjectRecord> {
    const provider = this.providers.translation;
    if (!provider.isConfigured()) {
      throw new AppError(
        503,
        'provider_not_configured',
        'AI translation is not set up on this server. Add OPENROUTER_API_KEY to the server settings (.env, see README), or type translations manually.',
      );
    }
    if (record.subtitles.length === 0) throw new AppError(422, 'no_subtitles', 'There are no subtitles to translate yet.');
    if (!findLanguage(options.targetLanguage)) throw new AppError(400, 'validation_error', 'Choose a valid target language.');
    if (isSameLanguage(record, options.targetLanguage)) {
      throw new AppError(422, 'same_language', 'The subtitles are already in that language. Choose a different target language.');
    }
    await this.store.update(record.id, (r) => {
      r.targetLanguage = options.targetLanguage;
    });
    const seconds = record.media?.duration ?? Math.max(60, ...record.subtitles.map((x) => x.end));
    const amount = translateCost(seconds, this.config.billing.costs);
    const charges: NonNullable<JobState['charges']> = { translate: this.credits.spend(record.ownerId, amount, `Translation: ${record.name.slice(0, 60)}`, record.id) };
    try {
      return await this.begin(record.id, 'translate', 'translating', 'Translating subtitles…', () =>
        this.runTranslation(record.id, options.targetLanguage, options.overwrite), charges, amount);
    } catch (error) {
      this.refundCharges(charges, 'Refund: task could not start');
      throw error;
    }
  }

  private async runTranslation(id: string, target: string, overwrite: boolean): Promise<void> {
    const signal = this.controllers.get(id)?.signal;
    try {
      const count = await this.translateMissing(id, target, overwrite, signal);
      await this.patchJob(id, {
        state: 'succeeded',
        stage: 'done',
        message: count > 0 ? `Translated ${count} subtitles. Please review them.` : 'Every subtitle already has a translation.',
      });
    } catch (error) {
      await this.failJob(id, error);
    } finally {
      this.controllers.delete(id);
    }
  }

  /** Translate subtitles batch by batch, saving after each batch. Returns how many were translated. */
  private async translateMissing(id: string, targetCode: string, overwrite: boolean, signal?: AbortSignal): Promise<number> {
    const provider = this.providers.translation;
    const target = findLanguage(targetCode);
    if (!target) throw new AppError(400, 'validation_error', 'Choose a valid target language.');

    const record = await this.mustGet(id);
    const todo = record.subtitles.filter((s) => overwrite || !hasTranslation(s));
    const sourceName =
      record.sourceLanguage !== 'auto'
        ? findLanguage(record.sourceLanguage)?.name
        : record.detectedLanguage
          ? record.detectedLanguage.charAt(0).toUpperCase() + record.detectedLanguage.slice(1)
          : undefined;

    let done = 0;
    for (let i = 0; i < todo.length; i += TRANSLATE_BATCH) {
      const batch = todo.slice(i, i + TRANSLATE_BATCH);
      await this.patchJob(id, { stage: 'translating', message: `Translating to ${target.name}… ${done}/${todo.length}` });
      const translated = await provider.translate({
        lines: batch.map((s) => s.text),
        sourceLanguage: sourceName,
        targetLanguage: target.name,
        signal,
      });
      const byId = new Map(batch.map((s, index) => [s.id, translated[index]]));
      await this.store.update(id, (r) => {
        for (const sub of r.subtitles) {
          const text = byId.get(sub.id);
          if (text) sub.translation = text; // the original `text` is never touched
        }
      });
      done += batch.length;
    }
    return done;
  }

  // -- prepare (trim + voice-over) -------------------------------------------

  /**
   * Cut the video to [trimStart, trimEnd] and/or replace its sound with the uploaded voice-over.
   * This permanently changes the stored video, so it is only allowed before subtitles exist.
   */
  async startPrepare(record: ProjectRecord, options: { trimStart: number; trimEnd: number; useVoiceover: boolean }): Promise<ProjectRecord> {
    const media = record.media;
    if (!media) throw new AppError(422, 'no_video', 'Upload a video first.');
    if (record.subtitles.length > 0) throw new AppError(409, 'subtitles_exist', 'Trim and voice-over can only be applied before subtitles are created.');
    if (options.useVoiceover && !media.voiceover) throw new AppError(422, 'no_voiceover', 'Upload a voice-over file first.');
    const { trimStart, trimEnd } = options;
    if (!(trimStart >= 0) || !(trimEnd > trimStart) || trimEnd > media.duration + 0.05) {
      throw new AppError(400, 'validation_error', 'The trim range is invalid.');
    }
    if (trimEnd - trimStart < 1) throw new AppError(400, 'validation_error', 'The trimmed video must be at least 1 second long.');
    if (media.preview.state === 'processing') this.controllers.get(`preview:${record.id}`)?.abort();
    return this.begin(record.id, 'prepare', 'preparing', 'Preparing your video…', () => this.runPrepare(record.id, options));
  }

  private async runPrepare(id: string, options: { trimStart: number; trimEnd: number; useVoiceover: boolean }): Promise<void> {
    const signal = this.controllers.get(id)?.signal;
    const dir = this.store.projectDir(id);
    const partial = path.join(dir, 'prepare.part.mp4');
    try {
      const record = await this.mustGet(id);
      const media = record.media as NonNullable<ProjectRecord['media']>;
      const length = Math.round((options.trimEnd - options.trimStart) * 1000) / 1000;
      const args = ['-y', '-ss', String(options.trimStart), '-t', String(length), '-i', path.join(dir, media.storedName)];
      if (options.useVoiceover && media.voiceover) args.push('-i', path.join(dir, media.voiceover.storedName));
      args.push('-map', '0:v:0');
      if (options.useVoiceover && media.voiceover) {
        // Voice-over time 0 lines up with the start of the trimmed video; pad with silence or cut at the video's end.
        args.push('-map', '1:a:0', '-af', 'apad', '-t', String(length));
      } else if (media.hasAudio) {
        args.push('-map', '0:a:0');
      }
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
      if (options.useVoiceover || media.hasAudio) args.push('-c:a', 'aac', '-b:a', '160k');
      args.push('-movflags', '+faststart', partial);
      await runFfmpeg(this.config, args, {
        signal,
        onProgress: (seconds) => void this.patchJob(id, { message: `Preparing your video… ${Math.min(99, Math.round((seconds / length) * 100))}%` }).catch(() => undefined),
      });

      const info = await probe(this.config, partial);
      if (!info.hasVideo || !(info.duration > 0)) throw new AppError(500, 'ffmpeg_failed', 'Video processing failed. Check that the file is a valid video.');
      const finalPath = path.join(dir, 'video.mp4');
      await rename(partial, finalPath);
      const size = (await stat(finalPath)).size;
      const oldNames = [media.storedName, media.preview.storedName, media.voiceover?.storedName].filter((n): n is string => !!n && n !== 'video.mp4');
      await this.store.update(id, (r) => {
        if (!r.media) return;
        r.media = {
          ...r.media,
          storedName: 'video.mp4',
          mimeType: 'video/mp4',
          size,
          duration: Math.round(info.duration * 1000) / 1000,
          width: info.width,
          height: info.height,
          hasAudio: info.hasAudio,
          videoCodec: info.videoCodec,
          audioCodec: info.audioCodec,
          preview: { state: 'not_needed' },
          prepared: true,
        };
        delete r.media.voiceover;
      });
      await Promise.all(oldNames.map((n) => rm(path.join(dir, n), { force: true })));
      await this.assets.clear(id);
      await this.patchJob(id, { state: 'succeeded', stage: 'done', message: 'Video is ready.' });
    } catch (error) {
      await rm(partial, { force: true });
      await this.failJob(id, error);
    } finally {
      this.controllers.delete(id);
    }
  }

  // -- preview proxy --------------------------------------------------------

  /** Queue creation of a browser-playable copy (runs one at a time). */
  startPreview(id: string): void {
    this.previewQueue = this.previewQueue.then(() => this.runPreview(id)).catch(() => undefined);
  }

  private async runPreview(id: string): Promise<void> {
    const key = `preview:${id}`;
    const controller = new AbortController();
    this.controllers.set(key, controller);
    try {
      const record = await this.store.get(id);
      if (!record?.media || record.media.preview.state !== 'processing') return;
      const dir = this.store.projectDir(id);
      const partial = path.join(dir, 'preview.part.mp4');
      await makePreview(
        this.config,
        path.join(dir, record.media.storedName),
        partial,
        record.media.duration,
        record.media.hasAudio,
        controller.signal,
      );
      await rename(partial, path.join(dir, 'preview.mp4'));
      await this.store.update(id, (r) => {
        if (r.media?.preview.state === 'processing') r.media.preview = { state: 'ready', storedName: 'preview.mp4' };
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error('[pipeline] preview failed:', error);
      await this.store
        .update(id, (r) => {
          if (r.media) r.media.preview = { state: 'failed', error: 'A playable preview could not be created for this video.' };
        })
        .catch(() => undefined);
    } finally {
      this.controllers.delete(key);
    }
  }

  // -- job state helpers ----------------------------------------------------

  private async begin(id: string, type: JobType, stage: string, message: string, run: () => Promise<void>, charges?: JobState['charges'], creditsCharged?: number): Promise<ProjectRecord> {
    if (this.controllers.has(id)) {
      throw new AppError(409, 'job_running', 'Another AI task is already running for this project.');
    }
    this.controllers.set(id, new AbortController()); // reserve before any await
    const now = new Date().toISOString();
    try {
      const updated = await this.store.update(id, (r) => {
        r.job = { type, state: 'running', stage, message, startedAt: now, updatedAt: now, ...(charges ? { charges, creditsCharged } : {}) };
      });
      void run();
      return updated;
    } catch (error) {
      this.controllers.delete(id);
      throw error;
    }
  }

  private refundCharges(charges: JobState['charges'] | undefined, reason: string): void {
    for (const ledgerId of Object.values(charges ?? {})) {
      if (typeof ledgerId !== 'number') continue;
      try {
        this.credits.refund(ledgerId, reason);
      } catch (error) {
        console.error('[pipeline] refund failed:', error);
      }
    }
  }

  private async mustGet(id: string): Promise<ProjectRecord> {
    const record = await this.store.get(id);
    if (!record) throw new AppError(404, 'project_not_found', 'Project not found.');
    return record;
  }

  private async patchJob(id: string, patch: Partial<JobState>): Promise<void> {
    await this.store.update(id, (r) => {
      if (!r.job) return;
      r.job = { ...r.job, ...patch, updatedAt: new Date().toISOString() };
      if (patch.warning === undefined) delete r.job.warning;
    });
  }

  private async failJob(id: string, error: unknown): Promise<void> {
    const canceled = isAppError(error) && error.code === 'canceled';
    const message = canceled ? 'Canceled.' : safeMessage(error);
    const record = await this.store.get(id).catch(() => null);
    this.refundCharges(record?.job?.charges, canceled ? 'Refund: task canceled' : 'Refund: task failed');
    await this.patchJob(id, { state: 'failed', stage: 'failed', message: 'Failed.', error: message }).catch(() => undefined);
  }
}
