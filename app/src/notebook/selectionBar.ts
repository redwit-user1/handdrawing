/** 선택 막대(복제·삭제·고치기) 자리 — 선택한 것 바로 위, 자리가 없으면 아래, 보이는 곳 안으로 */

export interface Box { x: number; y: number; w: number; h: number }
export interface Insets { top: number; right: number; bottom: number; left: number }

/** 선택 상자와 막대 사이 (화면 px) — 모서리 크기 손잡이(잡는 반지름 22px)를 가리지 않게 그보다 넓게 */
export const BAR_GAP = 28;
const PAD = 8;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * sel: 선택 영역(캔버스 기준 화면 px), bar: 막대 크기, view: 캔버스 크기, insets: 캔버스 위에 떠 있는 도구 막대 자리.
 * 가로는 선택 가운데, 세로는 위 → 아래 → (선택이 화면을 다 덮으면) 보이는 곳 맨 위. 언제나 보이는 곳 안.
 */
export function placeSelectionBar(sel: Box, bar: { w: number; h: number }, view: { w: number; h: number }, insets: Insets): { x: number; y: number } {
  const minX = insets.left + PAD, maxX = view.w - insets.right - PAD - bar.w;
  const minY = insets.top + PAD, maxY = view.h - insets.bottom - PAD - bar.h;
  const above = sel.y - BAR_GAP - bar.h;
  const below = sel.y + sel.h + BAR_GAP;
  const y = above >= minY ? above : below <= maxY ? below : minY;
  return { x: Math.round(clamp(sel.x + sel.w / 2 - bar.w / 2, minX, maxX)), y: Math.round(clamp(y, minY, maxY)) };
}
