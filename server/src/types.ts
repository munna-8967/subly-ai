import type { Subtitle } from '../../shared/subtitles.js';
import type { SubtitleStyle } from '../../shared/style.js';

export type { Subtitle, SubtitleStyle };

export interface Language {
  code: string;
  name: string;
}

export type JobType = 'transcribe' | 'translate' | 'prepare';

export interface JobState {
  type: JobType;
  state: 'running' | 'succeeded' | 'failed';
  /** machine-readable step: extracting_audio | transcribing | translating | done */
  stage: string;
  /** short human-readable status line */
  message: string;
  /** set when state is 'failed' */
  error?: string;
  /** set when the job finished but something non-fatal went wrong */
  warning?: string;
  /** ledger ids of the credits taken for this job, refunded if it fails (never sent to the browser) */
  charges?: { transcribe?: number; translate?: number };
  /** credits this job cost, shown to the user */
  creditsCharged?: number;
  startedAt: string;
  updatedAt: string;
}

export interface PreviewState {
  state: 'not_needed' | 'processing' | 'ready' | 'failed';
  storedName?: string;
  error?: string;
}

export interface MediaInfo {
  originalName: string;
  /** file name inside the project folder (never user-controlled) */
  storedName: string;
  mimeType: string;
  size: number;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  videoCodec: string;
  audioCodec?: string;
  preview: PreviewState;
  /** optional voice-over audio waiting to replace the video's own sound (see the prepare step) */
  voiceover?: { originalName: string; storedName: string; size: number; duration: number };
  /** true after the user trimmed the video or applied a voice-over */
  prepared?: boolean;
}

export interface RenderInfo {
  id: string;
  state: 'running' | 'succeeded' | 'failed' | 'expired';
  /** 0..1 */
  progress: number;
  track: 'original' | 'translation';
  error?: string;
  createdAt: string;
  finishedAt?: string;
  size?: number;
  /** ledger id of the credits taken for this render (refunded on failure; never sent to the browser) */
  chargeId?: number;
  creditsCharged?: number;
}

/** What is stored on disk in <dataDir>/projects/<id>/project.json */
export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** id of the user account that owns the project */
  ownerId: string;
  /** 'auto' or a language code */
  sourceLanguage: string;
  /** 'none' or a language code */
  targetLanguage: string;
  /** language name reported by the transcription provider, if any */
  detectedLanguage?: string;
  media: MediaInfo | null;
  subtitles: Subtitle[];
  style: SubtitleStyle;
  job: JobState | null;
  render: RenderInfo | null;
}

export type ProjectStatus = 'empty' | 'draft' | 'processing' | 'ready' | 'failed';
