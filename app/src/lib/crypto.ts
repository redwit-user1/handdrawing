import { SecureStorage } from '@aparajita/capacitor-secure-storage';
export { sha256Hex } from './hash.ts';

/**
 * 기기 내 데이터 암호화 — AES-GCM 256.
 * 키는 기기 보안 저장소(iOS 키체인 / Android 키스토어)에 한 번 만들어 둔다.
 * 브라우저 개발 환경에서는 플러그인이 localStorage로 대신하므로 보안 수준이 낮다(개발 전용).
 */
const KEY_NAME = 'goono-note.data-key.v1';
let keyPromise: Promise<CryptoKey> | null = null;

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function loadKey(): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) throw new Error('이 환경에서는 암호화(WebCrypto)를 쓸 수 없습니다. 보안 컨텍스트(https·앱)에서 실행하세요.');
  let raw = (await SecureStorage.get(KEY_NAME)) as string | null;
  if (!raw) {
    raw = toBase64(crypto.getRandomValues(new Uint8Array(32)));
    await SecureStorage.set(KEY_NAME, raw);
  }
  return crypto.subtle.importKey('raw', fromBase64(raw) as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function key(): Promise<CryptoKey> {
  keyPromise ??= loadKey();
  return keyPromise;
}

/** 평문 → [IV 12바이트 | 암호문] */
export async function encrypt(plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), plain as BufferSource));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

export async function decrypt(payload: Uint8Array): Promise<Uint8Array> {
  const iv = payload.subarray(0, 12);
  const ct = payload.subarray(12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, await key(), ct as BufferSource));
}

export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // v4
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 보안 저장소에 작은 값을 둔다 (기기 ID 등) */
export async function secureGet(name: string): Promise<string | null> {
  return (await SecureStorage.get(name)) as string | null;
}
export async function secureSet(name: string, value: string): Promise<void> {
  await SecureStorage.set(name, value);
}
