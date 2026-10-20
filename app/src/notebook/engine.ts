/**
 * 손글씨 엔진(handdrawing js/engine.js)을 앱 번들에 넣는다.
 * 웹 구노의 손글씨 편집기와 같은 파일이라, 앱에서 쓴 페이지 노트를 웹에서 그대로 열 수 있다.
 */
import '../../../js/engine.js';

/** paper: 종이 템플릿 id (없으면 기본 모눈) — 노트 전체에 적용, 저장 형식에 들어가 웹 구노도 같은 종이로 그린다 */
export interface PageLayout { type: 'pages'; pageW: number; pageH: number; gap: number; minPages?: number; date?: string; paper?: string }

/** 종이 템플릿 (엔진 PAPERS) — 간격은 월드 단위(페이지 폭 720 = 180mm) */
export interface PaperSpec { id: string; name: string; kind: 'grid' | 'lines' | 'dots' | 'blank'; step?: number; major?: number }

/** 저장 형식 (= 서버 data-strokes JSON) */
export interface NotebookDoc { title: string; strokes: unknown[]; layout: PageLayout }

/** 획·객체 (엔진 스키마 — js/engine.js) */
export interface Stroke { tool: string; points: number[][]; [k: string]: unknown }

/** 삽입 객체: 그림 + 원본. kind 로 무엇을 다시 열지 정한다 */
export type ObjectKind = 'math' | 'ce' | 'chem';
export interface ImageObject extends Stroke { tool: 'image'; src: string; kind?: ObjectKind; latex?: string; ce?: string; molfile?: string; smiles?: string }
export interface TableObject extends Stroke { tool: 'table'; rows: number; cols: number; cells: string[][]; header: boolean; colW: number[]; rowH: number[] }

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
  /** 펜·손가락이 화면에 닿아 입력 중이면 null 이 아니다 */
  drawing: unknown;
  undoStack: unknown[];
  redoStack: unknown[];
  scale: number;
  setStrokes(strokes: unknown[]): void;
  setLayout(layout: PageLayout | null): void;
  /** 지금 종이 id (페이지 모드가 아니면 null) */
  paperId(): string | null;
  /** 노트 전체 종이 바꾸기 — 사용자 편집(실행 취소·저장 대상) */
  setPaper(id: string): void;
  fitWidth(maxScale?: number): void;
  resize(): void;
  requestRender(bg?: boolean): void;
  undo(): void;
  redo(): void;
  clearSelection(): void;
  deleteSelection(): void;
  duplicateSelection(): void;
  selectedStrokes(): Stroke[];
  addImage(src: string, w: number, h: number, extra?: Partial<ImageObject>): Stroke | null;
  addTable(t: { rows: number; cols: number; cells?: string[][]; header?: boolean; width?: number }): Stroke | null;
  addTextBox(text: string, opts?: { fontSize?: number; width?: number; color?: string }): Stroke | null;
  updateObject(stroke: Stroke, patch: Record<string, unknown>): void;
  objectAt(wx: number, wy: number): Stroke | null;
  selectObject(stroke: Stroke): void;
  commitText(): void;
  editText(stroke: unknown): void;
  pageCount(): number;
  lastUsedPage(): number;
  /** 객체가 화면에 다 보이지 않으면 가운데로 넘긴다 */
  revealObject(stroke: Stroke): void;
  /** 사진을 시계 방향으로 90° 돌린다 (돌린 그림 데이터로 바꿈, 실행 취소 한 단계).
   *  true 돌림, false 돌릴 수 없음, null 무시(같은 사진을 돌리는 중·그 사이 바뀜) */
  rotateImage(stroke: Stroke): Promise<boolean | null>;
  /** 진행 중인 사진 돌리기가 모두 끝날 때까지 (편집기를 치우기 전 마지막 저장 앞) */
  whenIdle(): Promise<void>;
  /** 크기 손잡이 화면 좌표 (캔버스 기준 px) — 객체 하나만 선택했을 때 네 모서리, 아니면 [] */
  selectionHandles(): { corner: 'nw' | 'ne' | 'sw' | 'se'; x: number; y: number }[];
  /** 선택 영역의 화면 상자 (캔버스 기준 px) — 선택이 없으면 null */
  selectionScreenBox(): { x: number; y: number; w: number; h: number } | null;
  /** 편집기를 치울 때 — 창·visualViewport 리스너와 글상자 입력칸을 정리한다 (먼저 commitText) */
  destroy(): void;
  renderLayoutPages(): HTMLCanvasElement[];
  renderPageThumbnail(i?: number, width?: number): HTMLCanvasElement | null;
  whenImagesReady(): Promise<unknown>;
}

interface HandDrawingGlobal {
  DrawingEngine: new (canvas: HTMLCanvasElement, opts: EngineOptions) => Engine;
  defaultPageLayout: (date?: string, paper?: string) => PageLayout;
  A4_BODY_ASPECT: number;
  PAPERS: PaperSpec[];
  PAPER_DEFAULT: string;
  paperSpec: (id: unknown) => PaperSpec;
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

export function newDoc(title: string, createdAt = new Date(), paper?: string): NotebookDoc {
  return { title, strokes: [], layout: hd().defaultPageLayout(ymd(createdAt), paper) };
}

/** 고를 수 있는 종이들 (기본 모눈이 맨 앞) */
export function papers(): PaperSpec[] {
  return hd().PAPERS;
}
export const paperSpec = (id: unknown): PaperSpec => hd().paperSpec(id);

/** 마지막으로 고른 종이 — 새 노트 기본값 (프로젝트처럼 기기에 기억) */
const LAST_PAPER = 'goono-note.last-paper';
export function lastPaper(): string {
  try { return paperSpec(localStorage.getItem(LAST_PAPER)).id; } catch { return hd().PAPER_DEFAULT; }
}
export function rememberPaper(id: string) {
  try { localStorage.setItem(LAST_PAPER, paperSpec(id).id); } catch { /* 저장 안 됨 */ }
}

/** 페이지 머리글 — 왼쪽 "제목", 오른쪽 "2026-09-29 · 3쪽" (날짜는 노트를 만든 날, 엔진 기본 머리글과 같다) */
export function headerFor(title: string, createdAt: string) {
  const date = ymd(new Date(createdAt));
  return (i: number) => ({ left: title, right: `${date} · ${i + 1}쪽` });
}
