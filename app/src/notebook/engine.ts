/**
 * 손글씨 엔진(handdrawing js/engine.js)을 앱 번들에 넣는다.
 * 웹 구노의 손글씨 편집기와 같은 파일이라, 앱에서 쓴 페이지 노트를 웹에서 그대로 열 수 있다.
 */
import '../../../js/engine.js';

export interface PageLayout { type: 'pages'; pageW: number; pageH: number; gap: number; minPages?: number; date?: string }

/** 저장 형식 (= 서버 data-strokes JSON) */
export interface NotebookDoc { title: string; strokes: unknown[]; layout: PageLayout }

export type Tool = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'text' | 'shape' | 'pan';
export type ShapeKind = 'line' | 'arrow' | 'rect' | 'ellipse';

export interface EngineOptions {
  onChange?: (userEdit: boolean) => void;
  onViewport?: (scale: number) => void;
  onPenDetected?: () => void;
  onSelection?: (sel: unknown) => void;
  onTextEdit?: (editing: boolean) => void;
}

export interface Engine {
  tool: Tool;
  shape: ShapeKind;
  color: string;
  size: number;
  touchDraws: boolean;
  showGrid: boolean;
  readonly: boolean;
  strokes: unknown[];
  layout: PageLayout | null;
  insets: { top: number; right: number; bottom: number; left: number };
  pageHeader: ((i: number, n: number) => { left?: string; right?: string }) | null;
  selection: unknown;
  undoStack: unknown[];
  redoStack: unknown[];
  scale: number;
  setStrokes(strokes: unknown[]): void;
  setLayout(layout: PageLayout | null): void;
  fitWidth(maxScale?: number): void;
  resize(): void;
  requestRender(bg?: boolean): void;
  undo(): void;
  redo(): void;
  clearSelection(): void;
  deleteSelection(): void;
  duplicateSelection(): void;
  selectedStrokes(): unknown[];
  addImage(src: string, w: number, h: number): unknown;
  commitText(): void;
  editText(stroke: unknown): void;
  pageCount(): number;
  lastUsedPage(): number;
  renderLayoutPages(): HTMLCanvasElement[];
  renderPageThumbnail(i?: number, width?: number): HTMLCanvasElement | null;
  whenImagesReady(): Promise<unknown>;
}

interface HandDrawingGlobal {
  DrawingEngine: new (canvas: HTMLCanvasElement, opts: EngineOptions) => Engine;
  defaultPageLayout: (date?: string) => PageLayout;
  A4_BODY_ASPECT: number;
}

function hd(): HandDrawingGlobal {
  const g = (window as unknown as { HandDrawing?: HandDrawingGlobal }).HandDrawing;
  if (!g) throw new Error('손글씨 엔진을 불러오지 못했습니다.');
  return g;
}

export function createEngine(canvas: HTMLCanvasElement, opts: EngineOptions): Engine {
  return new (hd().DrawingEngine)(canvas, opts);
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function newDoc(title: string, createdAt = new Date()): NotebookDoc {
  return { title, strokes: [], layout: hd().defaultPageLayout(ymd(createdAt)) };
}

/** 페이지 머리글 — 왼쪽 "제목", 오른쪽 "2026-09-29 · 3쪽" (날짜는 노트를 만든 날, 엔진 기본 머리글과 같다) */
export function headerFor(title: string, createdAt: string) {
  const date = ymd(new Date(createdAt));
  return (i: number) => ({ left: title, right: `${date} · ${i + 1}쪽` });
}
