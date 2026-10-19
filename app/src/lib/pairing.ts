/**
 * QR 연결 코드·QR 내용 해석 (docs/SYNC-API.md §0). 저장소·네트워크에 의존하지 않는 순수 함수만 둔다(단위 테스트 대상).
 */

/** 서버 주소 정리 — 앞뒤 공백·끝 슬래시 제거 (api.ts 가 다시 내보낸다. 순수 모듈이 api.ts 를 가져오지 않도록 여기에 둔다) */
export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** 연결 코드 문자 집합 — 헷갈리는 0·O·1·I·L 제외 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;

export type PairingTarget = { serverUrl: string; code: string };
export type PairingError = 'NOT_PAIRING_QR' | 'INSECURE_SERVER' | 'BAD_CODE';

/** 대문자로 바꾸고 `-`·공백을 지운 뒤 8자·문자 집합을 확인한다. 맞지 않으면 null */
export function normalizeCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[-\s]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** 화면 표시용 `XXXX-XXXX` */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * QR 내용 `goono-note://pair?server=<https URL>&code=<XXXX-XXXX>` 해석.
 * 반환하는 code 는 정규화된 값(하이픈 없음) — 표시할 때만 formatCode 를 쓴다.
 * 개발 빌드만 `allowHttp` 로 http 서버를 허용한다.
 */
export function parsePairingUri(text: string, opts: { allowHttp?: boolean } = {}): PairingTarget | { error: PairingError } {
  let u: URL;
  try { u = new URL(text.trim()); } catch { return { error: 'NOT_PAIRING_QR' }; }
  if (u.protocol !== 'goono-note:' || u.hostname.toLowerCase() !== 'pair') return { error: 'NOT_PAIRING_QR' };

  const server = u.searchParams.get('server')?.trim() ?? '';
  let s: URL | null = null;
  try { s = new URL(server); } catch { /* 아래에서 거부 */ }
  const okProtocol = s?.protocol === 'https:' || (opts.allowHttp === true && s?.protocol === 'http:');
  if (!s || !okProtocol) return { error: 'INSECURE_SERVER' };

  const code = normalizeCode(u.searchParams.get('code') ?? '');
  if (!code) return { error: 'BAD_CODE' };
  return { serverUrl: normalizeServerUrl(server), code };
}

/**
 * 딥링크(앱 밖에서 열린 URL) 해석. `goono-note://pair` 가 아니면 우리 링크가 아니므로 null(무시).
 * 맞는 링크면 parsePairingUri 와 같은 결과 — 서버가 https 가 아니거나 코드가 틀린 링크는 {error} 로 돌려 원인을 알릴 수 있게 한다.
 */
export function pairingFromUrl(url: string, opts: { allowHttp?: boolean } = {}): PairingTarget | { error: PairingError } | null {
  const r = parsePairingUri(url, opts);
  return 'error' in r && r.error === 'NOT_PAIRING_QR' ? null : r;
}

/** 같은 딥링크가 이 시간 안에 다시 오면 한 번 온 것으로 본다 */
export const REPEATED_LINK_MS = 3000;

/**
 * 앱이 링크로 켜지면 같은 URL 이 두 길로 올 수 있다 — `App.getLaunchUrl()`(Android 콜드 스타트는 이것뿐)과
 * `appUrlOpen` 이벤트(iOS 는 켜질 때도 보낸다). 직전에 받은 링크와 같은 URL 이 곧바로 다시 오면 true(무시).
 */
export function isRepeatedLink(prev: { url: string; at: number } | null, url: string, at: number): boolean {
  return prev != null && prev.url === url && at - prev.at >= 0 && at - prev.at < REPEATED_LINK_MS;
}

/** 엉뚱한 QR 을 읽었을 때 — 연결을 시도하지 않고 원인을 알려 준다 */
export const PARSE_ERROR_MESSAGES: Record<PairingError, string> = {
  NOT_PAIRING_QR: '구노 연구노트 연결용 QR이 아닙니다. 구노 웹에서 띄운 연결 QR을 읽어 주세요.',
  INSECURE_SERVER: 'QR의 서버 주소가 올바르지 않거나 https가 아닙니다. 구노 웹에서 띄운 연결 QR인지 확인하세요.',
  BAD_CODE: 'QR의 연결 코드가 올바르지 않습니다. 구노 웹에서 새 QR을 띄워 주세요.',
};

/** 직접 입력한 코드가 8자·문자 집합에 맞지 않을 때 (요청을 보내지 않는다) */
export const BAD_CODE_INPUT_MESSAGE = '연결 코드는 8자입니다(예: K7Q2-M9XD). 숫자 0·1과 영문 O·I·L은 쓰지 않습니다.';

/** 연결(pair) 실패 안내 문구 — 서버 오류 코드별 (docs/SYNC-API.md §0) */
export const PAIR_ERROR_MESSAGES: Record<string, string> = {
  INVALID_PAIRING_CODE: '코드가 맞지 않거나 만료되었습니다. 구노 웹에서 새 QR을 띄워 주세요.',
  APP_DISABLED: '이 기관은 태블릿 연결을 사용하지 않습니다. 관리자에게 문의하세요.',
  DEVICE_NOT_ALLOWED: '이 기기는 연결할 수 없습니다. 관리자에게 문의하세요.',
  TOO_MANY_ATTEMPTS: '시도가 너무 많습니다. 잠시 후 다시 시도하세요.',
};
export const NETWORK_ERROR_MESSAGE = '서버에 연결할 수 없습니다. 처음 연결과 다시 연결은 인터넷 연결이 필요합니다.';

/**
 * 연결 실패를 화면 문구로. ApiError(status·code·retryAfterSec)와 일반 Error(다른 계정 거부 등)를 모두 받는다.
 * (api.ts 를 가져오지 않도록 모양만 본다 — 단위 테스트 대상)
 */
export function pairErrorMessage(e: { message: string; status?: number; code?: string; retryAfterSec?: number }): string {
  if (e.status === 0) return NETWORK_ERROR_MESSAGE;
  const known = e.code ? PAIR_ERROR_MESSAGES[e.code] : undefined;
  if (!known) return e.message;
  if (e.code === 'TOO_MANY_ATTEMPTS' && e.retryAfterSec) return `${known} (약 ${e.retryAfterSec}초 후)`;
  return known;
}
