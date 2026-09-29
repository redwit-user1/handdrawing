import type { EditLocation, Project, ServerNote, ServerStatus, User } from './types.ts';

/**
 * 동기화 API 클라이언트 (docs/SYNC-API.md).
 * 서버 오류는 ApiError(status, code), 연결 실패·시간 초과는 status 0 의 ApiError(code NETWORK)로 통일한다.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
  get isNetwork(): boolean { return this.status === 0; }
}

export interface TokenResponse { token: string; tokenExpiresAt: string; offlineGraceDays: number; serverTime: string }
export interface RegisterResponse extends TokenResponse { user: User }
export interface Bootstrap {
  user: User;
  projects: Project[];
  policy: { offlineGraceDays: number; maxImageBytes: number };
  serverTime: string;
}
export interface DeviceInfo { id: string; name: string; platform: string; model: string; appVersion: string }
export interface VersionUpload {
  meta: { clientVersionId: string; baseVersionId: number | null; deviceWrittenAt: string; contentHash: string; autoSave: boolean };
  noteContent: string;
  images: { src: string; bytes: Uint8Array; mime: string }[];
}

const JSON_TIMEOUT = 15_000;
const UPLOAD_TIMEOUT = 120_000;

export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

async function call<T>(serverUrl: string, path: string, init: RequestInit & { token?: string; timeout?: number } = {}): Promise<T> {
  const { token, timeout = JSON_TIMEOUT, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (typeof rest.body === 'string') headers.set('Content-Type', 'application/json');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res: Response;
  try {
    res = await fetch(`${normalizeServerUrl(serverUrl)}/api/app/v1${path}`, { ...rest, headers, signal: ctl.signal });
  } catch (e) {
    throw new ApiError(0, 'NETWORK', ctl.signal.aborted ? '서버 응답이 없습니다.' : '서버에 연결할 수 없습니다.', { cause: String(e) });
  } finally {
    clearTimeout(timer);
  }
  let body: Record<string, unknown> = {};
  try { body = await res.json(); } catch { /* 본문 없음 */ }
  if (!res.ok) {
    const e = (body.error ?? {}) as { code?: string; message?: string };
    throw new ApiError(res.status, e.code ?? `HTTP_${res.status}`, e.message ?? `서버 오류 (${res.status})`, body);
  }
  return body as T;
}

export const api = {
  register: (serverUrl: string, loginId: string, password: string, device: DeviceInfo) =>
    call<RegisterResponse>(serverUrl, '/devices/register', { method: 'POST', body: JSON.stringify({ loginId, password, device }) }),

  refresh: (serverUrl: string, token: string) =>
    call<TokenResponse>(serverUrl, '/devices/refresh', { method: 'POST', token, body: '{}' }),

  bootstrap: (serverUrl: string, token: string) => call<Bootstrap>(serverUrl, '/bootstrap', { token }),

  notes: (serverUrl: string, token: string) => call<{ notes: ServerNote[] }>(serverUrl, '/notes', { token }),

  createNote: (serverUrl: string, token: string, body: { clientNoteId: string; projectMno: number; title: string; deviceCreatedAt: string }) =>
    call<{ noteMno: number; status: ServerStatus; editLocation: EditLocation }>(serverUrl, '/notes', { method: 'POST', token, body: JSON.stringify(body) }),

  uploadVersion(serverUrl: string, token: string, noteMno: number, v: VersionUpload) {
    const form = new FormData();
    form.append('meta', JSON.stringify(v.meta));
    form.append('noteContent', v.noteContent);
    for (const img of v.images) {
      const ext = img.mime.split('/')[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'bin';
      form.append(`inlineImages[${img.src}]`, new Blob([img.bytes as BlobPart], { type: img.mime }), `image.${ext}`);
    }
    return call<{ versionId: number; receivedAt: string; duplicate?: boolean }>(serverUrl, `/notes/${noteMno}/versions`,
      { method: 'POST', token, body: form, timeout: UPLOAD_TIMEOUT });
  },

  release: (serverUrl: string, token: string, noteMno: number, lastVersionId: number | null) =>
    call<{ status: ServerStatus; editLocation: EditLocation }>(serverUrl, `/notes/${noteMno}/release`,
      { method: 'POST', token, body: JSON.stringify({ lastVersionId }) }),
};
