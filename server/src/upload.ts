import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Config } from './config.ts';
import { AppError } from './errors.ts';
import { probe } from './services/ffmpeg.ts';
import type { ProjectStore } from './services/store.ts';
import type { MediaInfo } from './types.ts';

export const ALLOWED_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi'] as const;
type Extension = (typeof ALLOWED_EXTENSIONS)[number];

/** Containers (as reported by ffprobe from the file's CONTENT) that we accept. */
const ALLOWED_CONTAINERS = ['mov', 'mp4', 'matroska', 'webm', 'avi'];

/** Make a client-supplied file name safe to store and display (it is never used as a path). */
export function displayName(raw: string | undefined): string {
  let name = raw ?? '';
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep the raw value */
  }
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001F\u007F<>:"/\\|?*]/g, '_').trim().slice(0, 200);
  return name || 'video';
}

/** Pick the stored extension from what the file REALLY is, using the user's choice only to tell similar types apart. */
function storedExtension(userExt: string, formats: string[]): Extension {
  if (formats.includes('avi')) return 'avi';
  if (formats.includes('matroska') || formats.includes('webm')) return userExt === 'webm' ? 'webm' : 'mkv';
  return userExt === 'mov' || userExt === 'm4v' ? userExt : 'mp4';
}

function contentTypeFor(ext: Extension): string {
  switch (ext) {
    case 'webm':
      return 'video/webm';
    case 'mkv':
      return 'video/x-matroska';
    case 'avi':
      return 'video/x-msvideo';
    default:
      return 'video/mp4';
  }
}

/** Can a browser play this file directly? If not, a transcoded preview is created. */
function browserCanPlay(ext: Extension, videoCodec: string, audioCodec?: string): boolean {
  if (ext === 'mp4' || ext === 'm4v' || ext === 'mov') {
    return videoCodec === 'h264' && (!audioCodec || audioCodec === 'aac' || audioCodec === 'mp3');
  }
  if (ext === 'webm') {
    return ['vp8', 'vp9', 'av1'].includes(videoCodec) && (!audioCodec || audioCodec === 'opus' || audioCodec === 'vorbis');
  }
  return false;
}

/** Stream a request body to `partial` with a size limit. Returns the number of bytes written. */
async function streamBody(req: IncomingMessage, partial: string, maxBytes: number, tooLargeMessage: string): Promise<number> {
  const declared = req.headers['content-length'] === undefined ? undefined : Number(req.headers['content-length']);
  if (declared !== undefined && (!Number.isFinite(declared) || declared < 0)) {
    throw new AppError(400, 'invalid_length', 'Invalid Content-Length header.');
  }
  if (declared === 0) throw new AppError(400, 'empty_file', 'The uploaded file is empty.');
  if (declared !== undefined && declared > maxBytes) throw new AppError(413, 'file_too_large', tooLargeMessage);

  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) callback(new AppError(413, 'file_too_large', tooLargeMessage));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(req, counter, createWriteStream(partial, { flags: 'w', mode: 0o600 }));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, 'upload_interrupted', 'The upload was interrupted. Please try again.');
  }
  if (received === 0) throw new AppError(400, 'empty_file', 'The uploaded file is empty.');
  return received;
}

/**
 * Receive the raw request body as the project's video, then verify it by reading
 * the file itself with ffprobe. Nothing from the client decides where the file is
 * written. On any failure the partial file is removed.
 */
export async function receiveVideo(config: Config, store: ProjectStore, req: IncomingMessage, projectId: string): Promise<MediaInfo> {
  const original = displayName(req.headers['x-file-name'] as string | undefined);
  const userExt = path.extname(original).slice(1).toLowerCase();
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(userExt)) {
    throw new AppError(415, 'unsupported_extension', `Unsupported file type. Use one of: ${ALLOWED_EXTENSIONS.map((e) => e.toUpperCase()).join(', ')}.`);
  }
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!(contentType.startsWith('video/') || contentType === 'application/octet-stream')) {
    throw new AppError(415, 'unsupported_media_type', 'Send the video as the raw request body with a video/* content type.');
  }

  const dir = store.projectDir(projectId);
  const partial = path.join(dir, 'upload.part');
  const tooLarge = `The video is larger than the ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB limit.`;

  try {
    const received = await streamBody(req, partial, config.maxUploadBytes, tooLarge);

    // Verify the real contents, not the name or the declared type.
    const info = await probe(config, partial);
    if (!info.hasVideo || info.width <= 0 || info.height <= 0) {
      throw new AppError(415, 'unsupported_media', 'This file does not contain a video stream.');
    }
    if (!info.formats.some((f) => ALLOWED_CONTAINERS.includes(f))) {
      throw new AppError(415, 'unsupported_media', 'Unsupported video container. Use MP4, MOV, M4V, WebM, MKV or AVI.');
    }
    if (!(info.duration > 0)) throw new AppError(415, 'unsupported_media', 'Could not determine the length of this video.');
    if (info.duration > config.maxDurationSeconds) {
      throw new AppError(422, 'video_too_long', `Videos longer than ${Math.round(config.maxDurationSeconds / 60)} minutes are not supported on this server.`);
    }

    const ext = storedExtension(userExt, info.formats);
    const storedName = `video.${ext}`;
    await rename(partial, path.join(dir, storedName));

    return {
      originalName: original,
      storedName,
      mimeType: contentTypeFor(ext),
      size: received,
      duration: Math.round(info.duration * 1000) / 1000,
      width: info.width,
      height: info.height,
      hasAudio: info.hasAudio,
      videoCodec: info.videoCodec,
      audioCodec: info.audioCodec,
      preview: browserCanPlay(ext, info.videoCodec, info.audioCodec) ? { state: 'not_needed' } : { state: 'processing' },
    };
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

export const VOICEOVER_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'webm'] as const;
const MAX_VOICEOVER_BYTES = 200 * 1024 * 1024;

/** Receive a voice-over audio file (raw body). It is checked with ffprobe and kept as `voiceover.<ext>`. */
export async function receiveVoiceover(config: Config, store: ProjectStore, req: IncomingMessage, projectId: string): Promise<NonNullable<MediaInfo['voiceover']>> {
  const original = displayName(req.headers['x-file-name'] as string | undefined);
  const ext = path.extname(original).slice(1).toLowerCase();
  if (!(VOICEOVER_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new AppError(415, 'unsupported_extension', `Unsupported audio type. Use one of: ${VOICEOVER_EXTENSIONS.map((e) => e.toUpperCase()).join(', ')}.`);
  }
  const dir = store.projectDir(projectId);
  const partial = path.join(dir, 'voiceover.part');
  try {
    const size = await streamBody(req, partial, MAX_VOICEOVER_BYTES, 'The voice-over file is larger than 200 MB.');
    const info = await probe(config, partial);
    if (!info.hasAudio) throw new AppError(415, 'unsupported_media', 'This file does not contain an audio track.');
    if (!(info.duration > 0)) throw new AppError(415, 'unsupported_media', 'Could not determine the length of this audio file.');
    if (info.duration > config.maxDurationSeconds) {
      throw new AppError(422, 'video_too_long', `Audio longer than ${Math.round(config.maxDurationSeconds / 60)} minutes is not supported on this server.`);
    }
    const storedName = `voiceover.${ext}`;
    await rename(partial, path.join(dir, storedName));
    return { originalName: original, storedName, size, duration: Math.round(info.duration * 1000) / 1000 };
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}
