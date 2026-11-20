import type { Account, AppConfig, AppNotification, BillingInfo, LedgerEntry, Payment, Project, RenderView } from '../types';
import type { Subtitle, SubtitleStyle } from '../shared';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Fired when the server says the session is gone, so the app can show the sign-in page. */
export const SESSION_EXPIRED_EVENT = 'subly:session-expired';

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  // The session lives in an HttpOnly cookie (sent automatically). The custom header is the CSRF protection.
  const headers: Record<string, string> = { 'X-Requested-With': 'subly' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'network_error', 'Could not reach the Subly AI server. Check that it is running and try again.');
  }
  if (response.status === 204) return undefined as T;
  let data: any = null;
  try {
    data = await response.json();
  } catch {
    /* not JSON */
  }
  if (!response.ok) {
    const err = data?.error;
    if (response.status === 401 && err?.code === 'not_signed_in') window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    throw new ApiError(response.status, err?.code ?? 'error', err?.message ?? `Request failed (${response.status}).`, err?.details);
  }
  return data as T;
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const details = Array.isArray(error.details) ? error.details : [];
    const first = details[0] as { message?: string } | string | undefined;
    const extra = typeof first === 'string' ? first : first?.message;
    return extra ? `${error.message} ${extra}` : error.message;
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export const isOutOfCredits = (error: unknown): boolean => error instanceof ApiError && error.code === 'insufficient_credits';

type ProjectBody = { name?: string; subtitles?: Subtitle[]; style?: SubtitleStyle; sourceLanguage?: string; targetLanguage?: string };

export const api = {
  config: () => request<AppConfig>('GET', '/api/config'),

  // accounts
  me: () => request<Account | { user: null }>('GET', '/api/auth/me'),
  register: (body: { email: string; password: string; name: string }) => request<Account>('POST', '/api/auth/register', body),
  login: (body: { email: string; password: string }) => request<Account>('POST', '/api/auth/login', body),
  logout: () => request<void>('POST', '/api/auth/logout'),
  changePassword: (body: { currentPassword: string; newPassword: string }) => request<void>('POST', '/api/auth/password', body),

  // projects
  listProjects: () => request<{ projects: Project[] }>('GET', '/api/projects'),
  createProject: (body: { sourceLanguage?: string; targetLanguage?: string; name?: string } = {}) => request<{ project: Project }>('POST', '/api/projects', body),
  getProject: (id: string, summary = false) => request<{ project: Project }>('GET', `/api/projects/${id}${summary ? '?summary=1' : ''}`),
  saveProject: (id: string, body: ProjectBody) => request<{ project: Project }>('PUT', `/api/projects/${id}`, body),
  deleteProject: (id: string) => request<void>('DELETE', `/api/projects/${id}`),
  estimate: (id: string, target: string) => request<{ credits: number; balance: number }>('GET', `/api/projects/${id}/estimate?target=${encodeURIComponent(target)}`),
  prepare: (id: string, body: { trimStart: number; trimEnd: number; useVoiceover: boolean }) => request<{ project: Project }>('POST', `/api/projects/${id}/prepare`, body),
  removeVoiceover: (id: string) => request<{ project: Project }>('DELETE', `/api/projects/${id}/voiceover`),
  transcribe: (id: string, overwrite: boolean) => request<{ project: Project }>('POST', `/api/projects/${id}/transcribe`, { overwrite }),
  translate: (id: string, targetLanguage: string, overwrite: boolean) => request<{ project: Project }>('POST', `/api/projects/${id}/translate`, { targetLanguage, overwrite }),
  startRender: (id: string, track: 'original' | 'translation') => request<{ render: RenderView }>('POST', `/api/projects/${id}/render`, { track }),
  getRender: (id: string) => request<{ render: RenderView }>('GET', `/api/projects/${id}/render`),
  /** URLs for <video>, <img> and <a>: the session cookie is sent automatically, so no token is needed. */
  videoUrl: (id: string) => `/api/projects/${id}/video`,
  renderUrl: (id: string) => `/api/projects/${id}/render/file`,
  assetUrl: (id: string, kind: 'poster' | 'strip' | 'waveform', version: string | number = '') => `/api/projects/${id}/assets/${kind}?v=${encodeURIComponent(String(version))}`,

  // billing
  billing: () => request<BillingInfo>('GET', '/api/billing'),
  ledger: (before?: number) => request<{ entries: LedgerEntry[] }>('GET', `/api/billing/ledger${before ? `?before=${before}` : ''}`),
  payments: () => request<{ payments: Payment[] }>('GET', '/api/billing/payments'),
  checkout: (itemId: string) => request<{ url: string; paymentId: string }>('POST', '/api/billing/checkout', { itemId }),
  portal: () => request<{ url: string }>('POST', '/api/billing/portal'),
  demoPayment: (id: string) => request<{ payment: { id: string; description: string; amount: number; currency: string; credits: number; status: string } }>('GET', `/api/billing/demo/${id}`),
  demoPay: (id: string) => request<{ status: string }>('POST', `/api/billing/demo/${id}/pay`),
  demoCancel: (id: string) => request<{ status: string }>('POST', `/api/billing/demo/${id}/cancel`),
  demoCancelSubscription: () => request<void>('POST', '/api/billing/demo-cancel-subscription'),
  notifications: () => request<{ items: AppNotification[]; unread: number }>('GET', '/api/notifications'),
  markNotificationsRead: () => request<void>('POST', '/api/notifications/read'),
};

/** PUT a file as the raw request body with XHR so the browser reports real progress. */
function uploadFile(url: string, file: File, fallbackType: string, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<Project> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('X-Requested-With', 'subly');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', file.type.startsWith(`${fallbackType}/`) ? file.type : 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data?.project) resolve(data.project as Project);
      else {
        if (xhr.status === 401) window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
        reject(new ApiError(xhr.status, data?.error?.code ?? 'upload_failed', data?.error?.message ?? `Upload failed (${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'network_error', 'The upload was interrupted. Check your connection and try again.'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled.'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}

export const uploadVideo = (id: string, file: File, onProgress: (f: number) => void, signal?: AbortSignal) => uploadFile(`/api/projects/${id}/video`, file, 'video', onProgress, signal);
export const uploadVoiceover = (id: string, file: File, onProgress: (f: number) => void, signal?: AbortSignal) => uploadFile(`/api/projects/${id}/voiceover`, file, 'audio', onProgress, signal);
