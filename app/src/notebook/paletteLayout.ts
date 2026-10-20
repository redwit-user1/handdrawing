/**
 * 필기 도구 막대가 화면에 다 들어가지 않을 때(Split View 1/3·1/2, Slide Over) 어떤 버튼을 남기고
 * 나머지를 "더보기"로 넣을지. 순수 함수 — ToolPalette 가 쓴다.
 */
export type PalItem = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'text' | 'shape' | 'insert' | 'ink' | 'undo' | 'redo' | 'touch';

/** 막대에 놓이는 순서 (넓을 때 그대로) */
export const PAL_ORDER: PalItem[] = ['pen', 'highlighter', 'eraser', 'lasso', 'text', 'shape', 'insert', 'ink', 'undo', 'redo', 'touch'];
/** 좁을 때 남길 차례 — 펜·지우개·올가미·실행 취소가 먼저 */
export const PAL_PRIORITY: PalItem[] = ['pen', 'eraser', 'lasso', 'undo', 'ink', 'highlighter', 'text', 'insert', 'redo', 'shape', 'touch'];

/** 넓을 때 막대 길이 (버튼 11 × 48 + 구분선 3 + 간격·안쪽 여백·테두리) — styles.css .palette 와 맞춘다 */
export const PAL_FULL_PX = 595;
/** 좁을 때 버튼 (44px — 터치 최소 크기) + 간격 2px, 막대 안쪽 여백 6px×2 + 테두리 1px×2 */
export const PAL_COMPACT_BTN = 44;
const GAP = 2;
const FRAME = 14;

export interface PaletteLayout { compact: boolean; shown: PalItem[]; more: PalItem[] }

/** room: 막대가 쓸 수 있는 길이 (세로 막대면 높이, 가로 막대면 폭, 화면 px) */
export function paletteLayout(room: number): PaletteLayout {
  if (!(room < PAL_FULL_PX)) return { compact: false, shown: PAL_ORDER, more: [] };
  // 버튼 n 개(더보기 포함)가 들어가는 수: n·44 + (n-1)·2 + 14 ≤ room
  const slots = Math.max(2, Math.floor((room - FRAME + GAP) / (PAL_COMPACT_BTN + GAP)));
  const keep = new Set(PAL_PRIORITY.slice(0, Math.min(PAL_ORDER.length, slots) - 1));
  if (keep.size >= PAL_ORDER.length - 1) return { compact: true, shown: PAL_ORDER, more: [] };
  return {
    compact: true,
    shown: PAL_ORDER.filter((i) => keep.has(i)),
    more: PAL_ORDER.filter((i) => !keep.has(i)),
  };
}

/** 컴팩트 막대 길이 (버튼 n 개 + 더보기) */
export function compactLength(buttons: number): number {
  return buttons * PAL_COMPACT_BTN + (buttons - 1) * GAP + FRAME;
}
