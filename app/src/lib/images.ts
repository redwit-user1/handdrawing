import { sha256Hex } from './hash.ts';

/**
 * 본문 이미지 주소 변환.
 *
 *   저장 형식(기기 안)   src="hdimg:{ref}"            — 암호화된 이미지 파일을 가리키는 불변 참조
 *   편집 형식(편집기)    src="blob:…"                  — 복호화한 이미지를 보여주는 임시 주소
 *   전송 형식(서버)      src="blob:goono-app/{ref}"    — 구노 saveEditor 와 같은 blob: 치환 규칙
 */
export const STORED_PREFIX = 'hdimg:';
export const UPLOAD_PREFIX = 'blob:goono-app/';
const STORED_RE = /src="hdimg:([A-Za-z0-9-]+)"/g;

export function refsIn(storedHtml: string): string[] {
  return [...new Set([...storedHtml.matchAll(STORED_RE)].map((m) => m[1]))];
}

export function storedToEditor(storedHtml: string, urlFor: (ref: string) => string | undefined): string {
  return storedHtml.replace(STORED_RE, (all, ref: string) => {
    const url = urlFor(ref);
    return url ? `src="${url}"` : all;
  });
}

/** 편집기 HTML의 blob: 주소를 저장 형식으로 되돌린다 (모르는 blob: 주소는 그대로 둔다) */
export function editorToStored(editorHtml: string, refFor: (url: string) => string | undefined): string {
  return editorHtml.replace(/src="(blob:[^"]+)"/g, (all, url: string) => {
    const ref = refFor(url);
    return ref ? `src="${STORED_PREFIX}${ref}"` : all;
  });
}

export function storedToUpload(storedHtml: string): string {
  return storedHtml.replace(STORED_RE, (_all, ref: string) => `src="${UPLOAD_PREFIX}${ref}"`);
}

/**
 * 내용 해시 (서버와 같은 규칙, docs/SYNC-API.md §6):
 * SHA-256( UTF-8(전송 HTML) ‖ 각 이미지(ref 정렬)마다 "\n" + ref + ":" + hex(SHA-256(바이트)) )
 */
export async function contentHash(uploadHtml: string, images: { ref: string; bytes: Uint8Array }[]): Promise<string> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [enc.encode(uploadHtml)];
  for (const img of [...images].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))) {
    parts.push(enc.encode(`\n${img.ref}:${await sha256Hex(img.bytes)}`));
  }
  const total = parts.reduce((n, a) => n + a.length, 0);
  const all = new Uint8Array(total);
  let o = 0;
  for (const a of parts) { all.set(a, o); o += a.length; }
  return sha256Hex(all);
}
