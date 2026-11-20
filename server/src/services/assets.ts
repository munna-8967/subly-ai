import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.ts';
import { runFfmpeg } from './ffmpeg.ts';
import type { ProjectStore } from './store.ts';
import type { ProjectRecord } from '../types.ts';

export type AssetKind = 'poster' | 'strip' | 'waveform';

/**
 * Small pictures for the editor's timeline: a poster frame, a strip of thumbnails and the audio waveform.
 * They are generated on first request, cached in <project>/assets/, and deleted whenever the video changes.
 */
export class AssetService {
  private readonly config: Config;
  private readonly store: ProjectStore;
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(config: Config, store: ProjectStore) {
    this.config = config;
    this.store = store;
  }

  async clear(projectId: string): Promise<void> {
    await rm(path.join(this.store.projectDir(projectId), 'assets'), { recursive: true, force: true });
  }

  /** Path of the (possibly just created) image. */
  get(record: ProjectRecord, kind: AssetKind): Promise<string> {
    const media = record.media;
    if (!media) throw new Error('no media');
    const key = `${record.id}:${kind}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const task = this.build(record, kind).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  private async build(record: ProjectRecord, kind: AssetKind): Promise<string> {
    const media = record.media as NonNullable<ProjectRecord['media']>;
    const dir = path.join(this.store.projectDir(record.id), 'assets');
    await mkdir(dir, { recursive: true });
    const out = path.join(dir, kind === 'waveform' ? 'waveform.png' : `${kind}.jpg`);
    if (await stat(out).then(() => true, () => false)) return out;
    const source = path.join(this.store.projectDir(record.id), media.storedName);
    const part = out.replace(/\.(jpg|png)$/, '.part.$1');
    const duration = Math.max(0.1, media.duration);

    if (kind === 'poster') {
      await runFfmpeg(this.config, ['-y', '-ss', String(Math.min(1, duration / 2)), '-i', source, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', part]);
    } else if (kind === 'strip') {
      const frames = 20;
      // One frame per equal slice of the video, 120 px wide each, tiled into one wide image.
      await runFfmpeg(this.config, ['-y', '-i', source, '-an', '-vf', `fps=${frames / duration},scale=120:-2,tile=${frames}x1`, '-frames:v', '1', '-q:v', '5', part]);
    } else {
      if (!media.hasAudio) throw new Error('no audio');
      await runFfmpeg(this.config, ['-y', '-i', source, '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=1600x120:colors=0xa78bfa', '-frames:v', '1', part]);
    }
    await rename(part, out);
    return out;
  }
}
