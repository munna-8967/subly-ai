import { randomUUID } from 'node:crypto';
import { mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderCost } from '../../../shared/credits.js';
import { hasTranslation, usableSubtitles } from '../../../shared/subtitles.js';
import type { Track } from '../../../shared/subtitles.js';
import type { Config } from '../config.ts';
import { AppError } from '../errors.ts';
import { buildAss } from './ass.ts';
import type { CreditsService } from './credits.ts';
import { checkRenderSupport, runFfmpeg } from './ffmpeg.ts';
import type { ProjectStore } from './store.ts';
import type { ProjectRecord, RenderInfo } from '../types.ts';

/** Only plain folder names are passed to FFmpeg's filter parser (it treats : , ' \ specially). */
const SAFE_FONTS_DIR = /^[\w ./-]+$/;

/**
 * Burns subtitles permanently into a copy of the video using FFmpeg + libass.
 * One render per project at a time, and a global cap on parallel renders because
 * encoding is CPU-heavy. Progress lives in memory; the final state is saved on
 * the project so it survives restarts.
 */
export class RenderManager {
  private config: Config;
  private store: ProjectStore;
  private credits: CreditsService;
  private active = new Map<string, AbortController>();
  private progress = new Map<string, number>();
  support: { available: boolean; reason?: string } = { available: false, reason: 'Not checked yet.' };

  constructor(config: Config, store: ProjectStore, credits: CreditsService) {
    this.config = config;
    this.store = store;
    this.credits = credits;
  }

  async init(): Promise<void> {
    this.support = await checkRenderSupport(this.config);
  }

  /** Mark renders that were running when the server stopped as failed. */
  async recover(): Promise<void> {
    for (const id of await this.store.listIds()) {
      const record = await this.store.get(id);
      if (record?.render?.state === 'running') {
        this.refund(record.render.chargeId, 'Refund: render interrupted by a server restart');
        await this.store.update(id, (r) => {
          if (r.render) {
            r.render.state = 'failed';
            r.render.error = 'The render was interrupted by a server restart. Start it again.';
          }
        });
      }
    }
  }

  /** The render as the browser should see it (live progress merged in). */
  view(record: ProjectRecord): RenderInfo | null {
    if (!record.render) return null;
    const { chargeId: _chargeId, ...visible } = record.render;
    if (record.render.state === 'running') {
      return { ...visible, progress: this.progress.get(record.id) ?? record.render.progress };
    }
    return visible;
  }

  cancel(id: string): void {
    this.active.get(id)?.abort();
  }

  async start(record: ProjectRecord, track: Track): Promise<RenderInfo> {
    if (!this.support.available) {
      throw new AppError(503, 'render_unavailable', this.support.reason ?? 'Video rendering is not available on this server.');
    }
    const media = record.media;
    if (!media) throw new AppError(422, 'no_video', 'Upload a video first.');
    const usable = usableSubtitles(record.subtitles);
    if (usable.length === 0) throw new AppError(422, 'no_subtitles', 'Add at least one subtitle before rendering a video.');
    if (track === 'translation' && !usable.some(hasTranslation)) {
      throw new AppError(422, 'no_translation', 'There are no translated subtitles to render. Translate the subtitles first or choose the original track.');
    }
    if (this.active.has(record.id)) throw new AppError(409, 'render_running', 'A render is already running for this project.');
    if (this.active.size >= this.config.maxConcurrentRenders) {
      throw new AppError(429, 'render_busy', 'The server is busy rendering another video. Try again in a few minutes.');
    }

    const controller = new AbortController();
    this.active.set(record.id, controller); // reserve before any await
    let chargeId: number | undefined;
    try {
      const amount = renderCost(media.duration, this.config.billing.costs);
      chargeId = this.credits.spend(record.ownerId, amount, `Video export: ${record.name.slice(0, 60)}`, record.id);
      const info: RenderInfo = {
        id: randomUUID(),
        state: 'running',
        progress: 0,
        track,
        createdAt: new Date().toISOString(),
        chargeId,
        creditsCharged: amount,
      };
      await this.store.update(record.id, (r) => {
        r.render = info;
      });
      void this.run(record.id, info.id, track, controller, chargeId);
      const { chargeId: _c, ...visible } = info;
      return visible;
    } catch (error) {
      this.active.delete(record.id);
      this.refund(chargeId, 'Refund: export could not start');
      throw error;
    }
  }

  private refund(chargeId: number | undefined, reason: string): void {
    if (chargeId === undefined) return;
    try {
      this.credits.refund(chargeId, reason);
    } catch (error) {
      console.error('[render] refund failed:', error);
    }
  }

  private async run(id: string, renderId: string, track: Track, controller: AbortController, chargeId: number): Promise<void> {
    let tmp: string | undefined;
    try {
      const record = await this.store.get(id);
      if (!record?.media) throw new AppError(404, 'project_not_found', 'Project not found.');
      const media = record.media;

      tmp = await mkdtemp(path.join(this.store.tmpDir, 'render-'));
      const assPath = path.join(tmp, 'subs.ass');
      const output = path.join(tmp, 'out.mp4');
      await writeFile(
        assPath,
        buildAss({ subtitles: record.subtitles, style: record.style, width: media.width, height: media.height, track }),
        'utf8',
      );

      // The subtitles filter is given a RELATIVE name and FFmpeg runs inside the temp
      // folder, so no user-influenced path ever reaches the filter parser.
      let filter = 'subtitles=subs.ass';
      if (this.config.fontsDir && SAFE_FONTS_DIR.test(this.config.fontsDir)) filter += `:fontsdir=${this.config.fontsDir}`;

      const args = ['-y', '-i', path.join(this.store.projectDir(id), media.storedName), '-map', '0:v:0'];
      if (media.hasAudio) args.push('-map', '0:a:0');
      args.push('-vf', filter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
      if (media.hasAudio) args.push('-c:a', 'aac', '-b:a', '160k');
      args.push('-movflags', '+faststart', output);

      await runFfmpeg(this.config, args, {
        cwd: tmp,
        signal: controller.signal,
        onProgress: (seconds) => this.progress.set(id, Math.min(0.99, media.duration > 0 ? seconds / media.duration : 0)),
      });

      // Replace any previous render for this project.
      const finalPath = this.store.renderPath(id);
      await rm(finalPath, { force: true });
      await rename(output, finalPath);
      const size = (await stat(finalPath)).size;
      await this.store.update(id, (r) => {
        if (r.render?.id === renderId) r.render = { ...r.render, state: 'succeeded', progress: 1, finishedAt: new Date().toISOString(), size };
      });
    } catch (error) {
      const canceled = controller.signal.aborted;
      const message = canceled ? 'The render was canceled.' : error instanceof AppError ? error.message : 'The render failed on the server.';
      if (!canceled && !(error instanceof AppError)) console.error('[render] unexpected error:', error);
      this.refund(chargeId, canceled ? 'Refund: export canceled' : 'Refund: export failed');
      await this.store
        .update(id, (r) => {
          if (r.render?.id === renderId) r.render = { ...r.render, state: 'failed', error: message, finishedAt: new Date().toISOString() };
        })
        .catch(() => undefined);
    } finally {
      if (tmp) await rm(tmp, { recursive: true, force: true });
      this.active.delete(id);
      this.progress.delete(id);
    }
  }
}
