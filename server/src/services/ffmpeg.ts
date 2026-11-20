import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from '../config.ts';
import { AppError } from '../errors.ts';

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string;
  audioCodec?: string;
  /** ffprobe format names, e.g. ['mov','mp4','m4a','3gp','3g2','mj2'] or ['matroska','webm'] */
  formats: string[];
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  disposition?: { attached_pic?: number };
  tags?: { rotate?: string };
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
}

/** Inspect a file's real contents (not its name) with ffprobe. */
export async function probe(config: Config, file: string): Promise<ProbeResult> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      config.ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
    ));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppError(503, 'ffmpeg_missing', 'FFmpeg is not installed on the server. See the README for setup.');
    }
    throw new AppError(415, 'unsupported_media', 'This file could not be read as a video. It may be corrupt or not a video.');
  }

  const data = JSON.parse(stdout) as { streams?: ProbeStream[]; format?: { format_name?: string; duration?: string } };
  const streams = data.streams ?? [];
  // Cover art in audio files shows up as a "video" stream; ignore it.
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === 'audio');

  let width = video?.width ?? 0;
  let height = video?.height ?? 0;
  const rotation = Math.abs(
    Number(video?.side_data_list?.find((d) => d.side_data_type === 'Display Matrix')?.rotation ?? video?.tags?.rotate ?? 0),
  );
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];

  const duration = Number(data.format?.duration ?? video?.duration ?? 0);
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    width,
    height,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name ?? '',
    audioCodec: audio?.codec_name,
    formats: (data.format?.format_name ?? '').split(',').filter(Boolean),
  };
}

export interface RunOptions {
  signal?: AbortSignal;
  /** called with the encoded position in seconds */
  onProgress?: (seconds: number) => void;
  cwd?: string;
}

/** Run FFmpeg with an argument array (never through a shell). */
export function runFfmpeg(config: Config, args: string[], options: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new AppError(409, 'canceled', 'The operation was canceled.'));
      return;
    }
    const child = spawn(
      config.ffmpegPath,
      ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', ...args],
      { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stderr = '';
    let buffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const m = /^out_time_(?:us|ms)=(\d+)$/.exec(line.trim());
        if (m && options.onProgress) options.onProgress(Number(m[1]) / 1_000_000);
      }
    });

    const onAbort = () => child.kill('SIGKILL');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      options.signal?.removeEventListener('abort', onAbort);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new AppError(503, 'ffmpeg_missing', 'FFmpeg is not installed on the server. See the README for setup.'));
      } else {
        reject(error);
      }
    });
    child.on('close', (code, signal) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (options.signal?.aborted) {
        reject(new AppError(409, 'canceled', 'The operation was canceled.'));
      } else if (code === 0) {
        resolve();
      } else {
        // Full detail stays in the server log; the client gets a generic message.
        console.error(`[ffmpeg] exited with ${signal ?? code}: ${stderr.trim()}`);
        reject(new AppError(500, 'ffmpeg_failed', 'Video processing failed. Check that the file is a valid video.'));
      }
    });
  });
}

/** Mono 16 kHz 32 kbps MP3 - small enough for speech-to-text upload limits. */
export function extractAudio(config: Config, video: string, output: string, signal?: AbortSignal): Promise<void> {
  return runFfmpeg(
    config,
    ['-y', '-i', video, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', output],
    { signal },
  );
}

/** Browser-playable H.264/AAC copy (max 1280 px wide) for formats browsers cannot play. */
export function makePreview(
  config: Config,
  video: string,
  output: string,
  duration: number,
  hasAudio: boolean,
  signal?: AbortSignal,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const args = ['-y', '-i', video, '-map', '0:v:0'];
  if (hasAudio) args.push('-map', '0:a:0');
  args.push(
    '-vf', "scale='min(1280,iw)':-2",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    output,
  );
  return runFfmpeg(config, args, {
    signal,
    onProgress: onProgress && duration > 0 ? (s) => onProgress(Math.min(1, s / duration)) : undefined,
  });
}

/** Check once at startup whether burned-in rendering can work on this machine. */
export async function checkRenderSupport(config: Config): Promise<{ available: boolean; reason?: string }> {
  try {
    const [filters, encoders] = await Promise.all([
      execFileAsync(config.ffmpegPath, ['-hide_banner', '-filters'], { timeout: 15_000 }),
      execFileAsync(config.ffmpegPath, ['-hide_banner', '-encoders'], { timeout: 15_000 }),
    ]);
    if (!/\bsubtitles\b/.test(filters.stdout)) {
      return { available: false, reason: 'Your FFmpeg build has no "subtitles" filter (libass). Install a full FFmpeg build.' };
    }
    if (!/\blibx264\b/.test(encoders.stdout)) {
      return { available: false, reason: 'Your FFmpeg build has no libx264 encoder. Install a full FFmpeg build.' };
    }
    return { available: true };
  } catch {
    return { available: false, reason: 'FFmpeg is not installed or not on PATH. See the README for setup.' };
  }
}
