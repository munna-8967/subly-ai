import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.ts';
import type { ProjectRecord } from '../types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isProjectId(value: string): boolean {
  return UUID.test(value);
}

export function newProjectId(): string {
  return randomUUID();
}

/**
 * File-based project storage:
 *   <dataDir>/projects/<uuid>/project.json   metadata, subtitles, style
 *   <dataDir>/projects/<uuid>/video.<ext>    the uploaded video
 *   <dataDir>/projects/<uuid>/preview.mp4    browser-friendly copy (only when needed)
 *   <dataDir>/renders/<uuid>.mp4             burned-in video output
 *   <dataDir>/tmp/                           scratch space, cleaned automatically
 *
 * Every read-modify-write goes through a per-project lock so concurrent
 * background jobs and API requests cannot overwrite each other.
 */
export class ProjectStore {
  readonly projectsDir: string;
  readonly rendersDir: string;
  readonly tmpDir: string;
  private locks = new Map<string, Promise<unknown>>();

  constructor(dataDir: string) {
    this.projectsDir = path.join(dataDir, 'projects');
    this.rendersDir = path.join(dataDir, 'renders');
    this.tmpDir = path.join(dataDir, 'tmp');
  }

  async init(): Promise<void> {
    await Promise.all([this.projectsDir, this.rendersDir, this.tmpDir].map((dir) => mkdir(dir, { recursive: true })));
  }

  /** Folder for a project. The id must be a UUID, so it can never escape the data dir. */
  projectDir(id: string): string {
    if (!isProjectId(id)) throw new AppError(404, 'project_not_found', 'Project not found.');
    return path.join(this.projectsDir, id);
  }

  renderPath(id: string): string {
    if (!isProjectId(id)) throw new AppError(404, 'project_not_found', 'Project not found.');
    return path.join(this.rendersDir, `${id}.mp4`);
  }

  private recordPath(id: string): string {
    return path.join(this.projectDir(id), 'project.json');
  }

  async create(record: ProjectRecord): Promise<void> {
    await mkdir(this.projectDir(record.id), { recursive: true });
    await this.write(record);
  }

  async get(id: string): Promise<ProjectRecord | null> {
    if (!isProjectId(id)) return null;
    try {
      return JSON.parse(await readFile(this.recordPath(id), 'utf8')) as ProjectRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async listIds(): Promise<string[]> {
    try {
      return (await readdir(this.projectsDir)).filter(isProjectId);
    } catch {
      return [];
    }
  }

  /** Read, change and save one project atomically. `mutate` may change the record in place. */
  update(id: string, mutate: (record: ProjectRecord) => void | ProjectRecord | Promise<void | ProjectRecord>): Promise<ProjectRecord> {
    return this.withLock(id, async () => {
      const record = await this.get(id);
      if (!record) throw new AppError(404, 'project_not_found', 'Project not found.');
      const next = (await mutate(record)) ?? record;
      next.updatedAt = new Date().toISOString();
      await this.write(next);
      return next;
    });
  }

  async delete(id: string): Promise<void> {
    await this.withLock(id, async () => {
      await rm(this.projectDir(id), { recursive: true, force: true });
      await rm(this.renderPath(id), { force: true });
    });
  }

  private async write(record: ProjectRecord): Promise<void> {
    const file = this.recordPath(record.id);
    const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify(record, null, 2), 'utf8');
    await rename(temp, file); // atomic replace: a crash never leaves a half-written file
  }

  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(id, tail);
    tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }
}
