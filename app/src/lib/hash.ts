/** SHA-256 소문자 hex (WebCrypto — 브라우저·Node 공통) */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
