import type { RawSegment } from '../segments.ts';

export type ProviderErrorCode =
  | 'not_configured'
  | 'auth'
  | 'rate_limited'
  | 'quota'
  | 'unavailable'
  | 'rejected'
  | 'bad_response'
  | 'timeout';

/** Error from an external AI service. The message is safe to show to the user. */
export class ProviderError extends Error {
  code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

export interface TranscriptionResult {
  /** language name reported by the provider (e.g. "english"), if any */
  language?: string;
  segments: RawSegment[];
}

export interface TranscriptionProvider {
  readonly id: string;
  readonly name: string;
  isConfigured(): boolean;
  /** longest audio (seconds) this provider accepts in one request */
  readonly maxAudioSeconds: number;
  /** largest audio file (bytes) this provider accepts in one request */
  readonly maxAudioBytes: number;
  /** human-readable note about limits, shown in the UI */
  readonly note: string;
  /** `language` is an ISO 639-1 code, or undefined for auto-detect */
  transcribe(input: { audioPath: string; language?: string; signal?: AbortSignal }): Promise<TranscriptionResult>;
}

export interface TranslationProvider {
  readonly id: string;
  readonly name: string;
  isConfigured(): boolean;
  readonly note: string;
  /** Translate lines, keeping the same count and order. Names are English language names. */
  translate(input: {
    lines: string[];
    sourceLanguage?: string;
    targetLanguage: string;
    signal?: AbortSignal;
  }): Promise<string[]>;
}

export interface Providers {
  transcription: TranscriptionProvider;
  translation: TranslationProvider;
}
