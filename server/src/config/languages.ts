import type { Language } from '../types.ts';

/**
 * Languages offered in the UI. To add or remove a language, edit this list.
 *
 * `code` is the ISO 639-1 code sent to the speech-to-text provider.
 * Make sure your configured providers actually support the languages you list:
 * the default OpenAI Whisper model supports all of these for transcription, and
 * the translation model is a general-purpose LLM, so quality varies by language
 * (especially for lower-resource languages). Always review translated text.
 */
export const LANGUAGES: Language[] = [
  { code: 'en', name: 'English' },
  { code: 'hi', name: 'Hindi' },
  { code: 'mr', name: 'Marathi' },
  { code: 'te', name: 'Telugu' },
  { code: 'ta', name: 'Tamil' },
  { code: 'bn', name: 'Bengali' },
  { code: 'ur', name: 'Urdu' },
  { code: 'gu', name: 'Gujarati' },
  { code: 'kn', name: 'Kannada' },
  { code: 'ml', name: 'Malayalam' },
  { code: 'pa', name: 'Punjabi' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'it', name: 'Italian' },
  { code: 'nl', name: 'Dutch' },
  { code: 'ru', name: 'Russian' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ar', name: 'Arabic' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese' },
  { code: 'id', name: 'Indonesian' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'pl', name: 'Polish' },
  { code: 'uk', name: 'Ukrainian' },
];

export function findLanguage(codeOrName: string | undefined | null): Language | undefined {
  if (!codeOrName) return undefined;
  const needle = codeOrName.trim().toLowerCase();
  return LANGUAGES.find((l) => l.code === needle || l.name.toLowerCase() === needle);
}
