import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { ProjectStore } from './store.ts';

const HOUR = 3_600_000;

/**
 * Housekeeping (retention policy):
 *  - finished renders are deleted after RENDER_RETENTION_HOURS (default 24h)
 *  - projects whose video never finished uploading are deleted after 2 hours
 *  - leftover scratch folders in data/tmp are deleted after 6 hours
 * Uploaded videos and subtitles are kept until the owner deletes the project.
 */
export async function runCleanup(config: Config, store: ProjectStore, now = Date.now(), onProjectDeleted?: (id: string) => void): Promise<{ renders: number; projects: number; temp: number }> {
  const result = { renders: 0, projects: 0, temp: 0 };

  for (const id of await store.listIds()) {
    const record = await store.get(id);
    if (!record) continue;

    if (!record.media && now - Date.parse(record.createdAt) > 2 * HOUR) {
      await store.delete(id);
      onProjectDeleted?.(id);
      result.projects += 1;
      continue;
    }

    const render = record.render;
    if (render?.state === 'succeeded' && render.finishedAt && now - Date.parse(render.finishedAt) > config.renderRetentionHours * HOUR) {
      await rm(store.renderPath(id), { force: true });
      await store.update(id, (r) => {
        if (r.render?.id === render.id) r.render = { ...r.render, state: 'expired' };
      });
      result.renders += 1;
    }
  }

  try {
    for (const entry of await readdir(store.tmpDir)) {
      const full = path.join(store.tmpDir, entry);
      const info = await stat(full).catch(() => null);
      if (info && now - info.mtimeMs > 6 * HOUR) {
        await rm(full, { recursive: true, force: true });
        result.temp += 1;
      }
    }
  } catch {
    /* tmp folder missing: nothing to clean */
  }
  return result;
}

/** Run cleanup now and then every 15 minutes. Returns a function that stops it. */
export function scheduleCleanup(config: Config, store: ProjectStore, onProjectDeleted?: (id: string) => void): () => void {
  const run = () => runCleanup(config, store, Date.now(), onProjectDeleted).catch((error) => console.error('[cleanup] failed:', error));
  void run();
  const timer = setInterval(run, 15 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
