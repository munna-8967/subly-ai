import type { Config } from '../../config.ts';
import { OpenRouterTranscription, OpenRouterTranslation } from './openrouter.ts';
import type { Providers } from './types.ts';

/**
 * Pick the providers. To use another service, implement TranscriptionProvider /
 * TranslationProvider (see types.ts) and return it here - nothing else changes.
 */
export function createProviders(config: Config): Providers {
  return {
    transcription: new OpenRouterTranscription(config),
    translation: new OpenRouterTranslation(config),
  };
}

export type { Providers } from './types.ts';
