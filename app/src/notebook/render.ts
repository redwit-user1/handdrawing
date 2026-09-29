import { sha256Hex } from '../lib/hash.ts';
import { createEngine, headerFor, type Engine, type NotebookDoc } from './engine.ts';

/**
 * 버전용 렌더링: 노트(획 JSON) → 페이지 PNG + 웹 구노와 같은 손글씨 블록 HTML.
 *
 *   <figure class="rw-drawing" data-strokes="{title,strokes,layout}" data-drawing-sha256="…">
 *     <img src="hdimg:{ref}" alt="손글씨 1/2쪽"> …
 *   </figure>
 *
 * editor-ai DrawingImage 와 같은 형식이라 서버(createNoteEditorDtl)·웹 편집기·PDF 변환이 그대로 받는다.
 */
const PAGE_IMG_STYLE = 'display:block;width:100%;height:auto;break-inside:avoid';

let hidden: Engine | null = null;

/** 화면 밖 엔진 하나를 재사용해 렌더한다 (이벤트 리스너가 쌓이지 않게) */
function offscreen(doc: NotebookDoc, createdAt: string): Engine {
  if (!hidden) {
    const wrap = document.createElement('div');
    wrap.setAttribute('aria-hidden', 'true');
    Object.assign(wrap.style, { position: 'fixed', left: '-10000px', top: '0', width: '800px', height: '600px', overflow: 'hidden', pointerEvents: 'none' });
    const canvas = document.createElement('canvas');
    wrap.appendChild(canvas);
    document.body.appendChild(wrap);
    hidden = createEngine(canvas, {});
  }
  hidden.setLayout(doc.layout);
  hidden.pageHeader = headerFor(doc.title, createdAt);
  hidden.setStrokes(JSON.parse(JSON.stringify(doc.strokes)));
  return hidden;
}

export function canonicalJson(doc: NotebookDoc): string {
  return JSON.stringify({ title: doc.title, strokes: doc.strokes, layout: doc.layout });
}

async function canvasPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
  if (!blob) throw new Error('페이지 이미지를 만들지 못했습니다.');
  return new Uint8Array(await blob.arrayBuffer());
}

export interface RenderedDoc { pngs: Uint8Array[]; canonical: string; sha256: string; texts: string[] }

export async function renderDoc(doc: NotebookDoc, createdAt: string): Promise<RenderedDoc> {
  const engine = offscreen(doc, createdAt);
  await engine.whenImagesReady();
  const pages = engine.renderLayoutPages();
  const pngs: Uint8Array[] = [];
  for (const c of pages) pngs.push(await canvasPng(c));
  const canonical = canonicalJson(doc);
  const texts = (doc.strokes as { tool?: string; text?: string }[]).filter((s) => s.tool === 'text' && s.text).map((s) => s.text as string);
  return { pngs, canonical, sha256: await sha256Hex(canonical), texts };
}

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function drawingHtml(canonical: string, sha256: string, refs: string[]): string {
  if (!refs.length) return '';
  const imgs = refs.map((r, i) => `<img src="hdimg:${r}" alt="손글씨 ${i + 1}/${refs.length}쪽" style="${PAGE_IMG_STYLE}">`).join('');
  return `<figure class="rw-drawing" style="margin:0" data-strokes="${escAttr(canonical)}" data-drawing-sha256="${sha256}">${imgs}</figure>`;
}

/** 버전 HTML 에서 노트(획 JSON)를 되살린다 — 미반영 기록 복원용 */
export function docFromHtml(html: string): NotebookDoc | null {
  const fig = new DOMParser().parseFromString(html, 'text/html').querySelector('figure[data-strokes]');
  if (!fig) return null;
  try {
    const d = JSON.parse(fig.getAttribute('data-strokes') || '') as Partial<NotebookDoc>;
    if (!Array.isArray(d.strokes) || !d.layout) return null;
    return { title: d.title ?? '', strokes: d.strokes, layout: d.layout };
  } catch {
    return null;
  }
}

/** 목록 썸네일 (첫 페이지) */
export async function thumbnailOf(doc: NotebookDoc, createdAt: string): Promise<string | null> {
  if (!doc.strokes.length) return null;
  const engine = offscreen(doc, createdAt);
  await engine.whenImagesReady();
  const c = engine.renderPageThumbnail(0, 220);
  return c ? c.toDataURL('image/jpeg', 0.8) : null;
}
