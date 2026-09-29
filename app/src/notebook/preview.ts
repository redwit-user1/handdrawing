import { db } from '../lib/db.ts';
import { refsIn, storedToEditor } from '../lib/images.ts';

/** 버전 미리보기: 저장 형식 HTML(hdimg:) → 화면 표시용 HTML(blob: 주소). 다 보면 revoke */
export async function previewHtml(stored: string): Promise<{ html: string; revoke: () => void }> {
  const urls: string[] = [];
  const map = new Map<string, string>();
  for (const ref of refsIn(stored)) {
    const img = await db.getImage(ref);
    if (!img) continue;
    const url = URL.createObjectURL(new Blob([img.bytes as BlobPart], { type: img.mime }));
    urls.push(url);
    map.set(ref, url);
  }
  return { html: storedToEditor(stored, (r) => map.get(r)), revoke: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
}

/** 미리보기용 최소 정리 (스크립트·이벤트 속성 제거) */
export function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('script, iframe, object, embed, link, meta, style').forEach((el) => el.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
  });
  return doc.body.innerHTML;
}
