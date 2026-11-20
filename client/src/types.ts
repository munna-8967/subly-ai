import type { Subtitle, SubtitleStyle } from './shared';

export interface Language { code: string; name: string }

export interface JobState {
  type: 'transcribe' | 'translate' | 'prepare';
  state: 'running' | 'succeeded' | 'failed';
  stage: string;
  message: string;
  error?: string;
  warning?: string;
  creditsCharged?: number;
}

export interface RenderView {
  id: string;
  state: 'running' | 'succeeded' | 'failed' | 'expired';
  /** 0..1 */
  progress: number;
  track: 'original' | 'translation';
  error?: string;
  createdAt: string;
  finishedAt?: string;
  size?: number;
  creditsCharged?: number;
}

export type ProjectStatus = 'empty' | 'draft' | 'processing' | 'ready' | 'failed';

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  status: ProjectStatus;
  sourceLanguage: string;
  targetLanguage: string;
  detectedLanguage: string | null;
  style: SubtitleStyle;
  job: JobState | null;
  render: RenderView | null;
  subtitleCount: number;
  media: {
    originalName: string;
    mimeType: string;
    size: number;
    duration: number;
    width: number;
    height: number;
    hasAudio: boolean;
    preview: { state: 'not_needed' | 'processing' | 'ready' | 'failed'; error: string | null };
    voiceover: { originalName: string; duration: number; size: number } | null;
    prepared: boolean;
  } | null;
  /** present unless the project was loaded with summary=1 */
  subtitles?: Subtitle[];
}

export interface AppConfig {
  app: { name: string; version: string };
  limits: { maxUploadBytes: number; maxDurationSeconds: number; allowedExtensions: string[]; maxSubtitles: number };
  languages: Language[];
  providers: {
    transcription: { id: string; name: string; configured: boolean; maxDurationSeconds: number; note: string };
    translation: { id: string; name: string; configured: boolean; note: string };
  };
  render: { available: boolean; reason: string | null; retentionHours: number };
  credits: { costs: CreditCosts; freeMonthly: number; paymentsMode: PaymentsMode; lowThreshold: number };
  voiceoverExtensions: string[];
}

export type PaymentsMode = 'demo' | 'stripe' | 'off';
export interface CreditCosts { transcribePerMinute: number; translateMinutesPerCredit: number; renderMinutesPerCredit: number }

export interface User { id: string; email: string; name: string; createdAt: string }
export interface Balance { free: number; paid: number; total: number; freeResetsAt: string; freeMonthly: number; plan: string }
export interface SubscriptionInfo { plan: string; planRenewsAt: string | null; subscriptionStatus: string | null; canManageSubscription: boolean }
export interface Account { user: User; credits: Balance; subscription: SubscriptionInfo; unreadNotifications: number }

export interface CatalogItem { id: string; kind: 'plan' | 'pack'; name: string; description: string; amount: number; credits: number; currency: string; interval?: 'month' }
export interface BillingInfo {
  mode: PaymentsMode; note: string; currency: string; catalog: CatalogItem[]; costs: CreditCosts; lowCreditThreshold: number;
  credits: Balance; subscription: SubscriptionInfo;
}
export interface LedgerEntry { id: number; createdAt: string; kind: string; delta: number; freeAfter: number; paidAfter: number; description: string; projectId: string | null }
export interface Payment { id: string; createdAt: string; provider: string; kind: string; description: string; amount: number; currency: string; credits: number; status: string }
export interface AppNotification { id: number; createdAt: string; kind: string; title: string; body: string; read: boolean }
