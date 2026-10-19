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
