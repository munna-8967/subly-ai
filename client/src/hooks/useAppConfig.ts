import { useEffect, useState } from 'react';
import { api, describeError } from '../lib/api';
import type { AppConfig } from '../types';

let cached: AppConfig | null = null;

/** Server limits, languages and provider status (loaded once per page load). */
export function useAppConfig(): { config: AppConfig | null; error: string | null } {
  const [config, setConfig] = useState<AppConfig | null>(cached);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (cached) return;
    let alive = true;
    api
      .config()
      .then((value) => {
        cached = value;
        if (alive) setConfig(value);
      })
      .catch((e) => alive && setError(describeError(e)));
    return () => {
      alive = false;
    };
  }, []);
  return { config, error };
}
