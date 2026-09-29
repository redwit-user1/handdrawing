import { db } from '../lib/db.ts';
import { fromBase64 } from '../lib/crypto.ts';
import { editorToStored, refsIn, storedToEditor } from '../lib/images.ts';
import { saveWorking } from '../lib/notes.ts';

/**
 * editor-ai(스탠드얼론 번들) 호스트.
 *
 * 번들은 앱에 내장(public/vendor/editor-ai)되어 오프라인에서 그대로 동작한다. 손글씨는 editor-ai 의
 * 손글씨 삽입(handdrawing iframe, public/handdrawing)을 쓰고, 페이지 이미지는 onImageUpload 로 받아
 * 기기에 암호화 저장한다. 편집기에는 복호화한 blob: 주소를, 저장소에는 hdimg:{ref} 를 둔다.
 */

interface EditorInstance {
  ready: Promise<void>;
  getHTML(): string;
  setReadOnly(v: boolean): void;
  destroy(): void;
}
interface EditorModule {
  RedwitEditorAI: new (elementId: string, options: Record<string, unknown>) => EditorInstance;
}

let modulePromise: Promise<EditorModule> | null = null;

function loadEditorModule(): Promise<EditorModule> {
  if (!modulePromise) {
    const base = new URL('vendor/editor-ai/', document.baseURI);
    if (!document.querySelector('link[data-editor-ai]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = new URL('style.css', base).href;
      link.dataset.editorAi = '1';
      document.head.appendChild(link);
    }
    modulePromise = import(/* @vite-ignore */ new URL('editor-ai.standalone.js', base).href) as Promise<EditorModule>;
    modulePromise.catch(() => { modulePromise = null; });
  }
  return modulePromise;
}

const DATA_IMG_RE = /src="(data:(image\/[a-zA-Z0-9.+-]+);base64,([^"]+))"/g;
const AUTOSAVE_DEBOUNCE_MS = 800;

export interface EditorSessionOptions {
  elementId: string;
  noteId: string;
  readOnly: boolean;
  maxImageBytes: number;
  /** 작업본이 기기에 저장될 때마다 */
  onSaved?: () => void;
  onError?: (message: string) => void;
}

export class EditorSession {
  private inst: EditorInstance | null = null;
  private urlToRef = new Map<string, string>();
  private refToUrl = new Map<string, string>();
  private dataUrlToRef = new Map<string, string>();
  private savedEditorHtml = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private destroyed = false;

  constructor(private readonly opts: EditorSessionOptions) {}

  /** 작업본(없으면 빈 문서)을 불러와 편집기를 띄운다 */
  async open(storedHtmlOverride?: string): Promise<void> {
    const [mod, working] = await Promise.all([loadEditorModule(), db.getWorking(this.opts.noteId)]);
    const stored = storedHtmlOverride ?? working?.html ?? '';
    for (const ref of refsIn(stored)) await this.urlFor(ref);
    if (this.destroyed) return;
    const html = storedToEditor(stored, (ref) => this.refToUrl.get(ref));

    this.inst = new mod.RedwitEditorAI(this.opts.elementId, {
      initialContent: html,
      readOnly: this.opts.readOnly,
      apiBasePath: null,
      mathliveFontsDirectory: null,
      maxImageBytes: this.opts.maxImageBytes,
      config: { drawingEditorUrl: 'handdrawing/index.html', features: { ai: false } },
      onChange: () => this.schedule(),
      onSave: () => this.flush(),
      onImageUpload: (file: File) => this.storeImage(file),
    });
    await this.inst.ready;
    this.savedEditorHtml = this.inst.getHTML();
  }

  private async urlFor(ref: string): Promise<string | undefined> {
    const known = this.refToUrl.get(ref);
    if (known) return known;
    const img = await db.getImage(ref);
    if (!img) return undefined;
    const url = URL.createObjectURL(new Blob([img.bytes as BlobPart], { type: img.mime }));
    this.refToUrl.set(ref, url);
    this.urlToRef.set(url, ref);
    return url;
  }

  private async storeImage(file: File): Promise<string> {
    if (file.size > this.opts.maxImageBytes) throw new Error('이미지가 너무 큽니다.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ref = await db.putImage(bytes, file.type || 'image/png', this.opts.noteId);
    const url = URL.createObjectURL(file);
    this.refToUrl.set(ref, url);
    this.urlToRef.set(url, ref);
    return url;
  }

  private schedule(): void {
    if (this.opts.readOnly || this.destroyed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, AUTOSAVE_DEBOUNCE_MS);
  }

  /** 바뀐 내용이 있으면 지금 작업본으로 저장 */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.saving = this.saving.then(() => this.saveNow()).catch((e) => {
      this.opts.onError?.(`작업본을 저장하지 못했습니다: ${(e as Error)?.message ?? e}`);
    });
    return this.saving;
  }

  private async saveNow(): Promise<void> {
    if (!this.inst || this.opts.readOnly) return;
    const html = this.inst.getHTML();
    if (html === this.savedEditorHtml) return;
    let stored = editorToStored(html, (url) => this.urlToRef.get(url));
    stored = await this.inlineDataImages(stored);
    await saveWorking(this.opts.noteId, stored);
    this.savedEditorHtml = html;
    this.opts.onSaved?.();
  }

  /** 업로드 폴백으로 본문에 남은 data: 이미지도 기기 이미지로 옮긴다(같은 이미지는 한 번만) */
  private async inlineDataImages(stored: string): Promise<string> {
    const found = [...stored.matchAll(DATA_IMG_RE)];
    for (const [, dataUrl, mime, b64] of found) {
      if (this.dataUrlToRef.has(dataUrl)) continue;
      this.dataUrlToRef.set(dataUrl, await db.putImage(fromBase64(b64), mime, this.opts.noteId));
    }
    return stored.replace(DATA_IMG_RE, (all, dataUrl: string) => {
      const ref = this.dataUrlToRef.get(dataUrl);
      return ref ? `src="hdimg:${ref}"` : all;
    });
  }

  setReadOnly(v: boolean): void {
    this.opts.readOnly = v;
    try { this.inst?.setReadOnly(v); } catch { /* 준비 전 */ }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    await this.flush();
    this.destroyed = true;
    try { this.inst?.destroy(); } catch { /* 이미 제거 */ }
    this.inst = null;
    for (const url of this.urlToRef.keys()) URL.revokeObjectURL(url);
    this.urlToRef.clear();
    this.refToUrl.clear();
  }
}

/** 미반영 기록 보기 등 읽기 전용 미리보기용: 저장 형식 HTML → 화면 표시용 HTML(blob: 주소) */
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
