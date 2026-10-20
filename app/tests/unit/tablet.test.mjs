import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyboardInsets, KB_MIN_PX } from '../../src/lib/keyboard.ts';
import { compactLength, paletteLayout, PAL_FULL_PX, PAL_ORDER } from '../../src/notebook/paletteLayout.ts';

// 엔진(js/engine.js)은 window 에 붙는 스크립트 — 화면 관련 순수 함수만 확인한다
globalThis.window = globalThis.window ?? {};
await import('../../../js/engine.js');
const { eraserRadiusFor, ERASER_PEN_PX, ERASER_PX } = globalThis.window.HandDrawing.input;
const { textInputScale, revealDelta, fitScaleFor, anchorView, INPUT_MIN_FONT_PX } = globalThis.window.HandDrawing.view;

test('지우개 반지름: 펜 8px, 손가락·마우스 16px(예전과 같다)', () => {
  assert.equal(ERASER_PEN_PX, 8);
  assert.equal(ERASER_PX, 16);
  assert.equal(eraserRadiusFor('pen'), 8);
  assert.equal(eraserRadiusFor('touch'), 16);
  assert.equal(eraserRadiusFor('mouse'), 16);
  assert.equal(eraserRadiusFor(undefined), 16);
});

test('글상자 입력칸: 화면 글자가 16px 미만이면 키워서 쓰고 그만큼 줄여 보인다', () => {
  assert.equal(INPUT_MIN_FONT_PX, 16);
  assert.equal(textInputScale(20), 1);
  assert.equal(textInputScale(16), 1);
  assert.equal(textInputScale(12), 16 / 12);
  assert.equal(12 * textInputScale(12), 16, '실제 글자 16px');
  assert.equal(textInputScale(0), 1, '크기 0 은 그대로');
});

test('글상자 보이기: 아래가 가리면 올리고(커서 줄 우선), 위로 넘치면 내리고, 안이면 그대로', () => {
  const vis = { top: 60, bottom: 500 };
  assert.equal(revealDelta({ top: 100, bottom: 200 }, vis), 0);
  assert.equal(revealDelta({ top: 450, bottom: 560 }, vis), 560 - (500 - 16), '키보드 위 16px 까지 올림');
  assert.equal(revealDelta({ top: 30, bottom: 120 }, vis), -(60 + 16 - 30), '위로 넘침 → 내림');
  // 보이는 영역보다 큰 칸은 아래(커서)를 맞춘다
  assert.equal(revealDelta({ top: 0, bottom: 900 }, vis), 900 - 484);
});

test('폭 맞춤 배율: 여백을 뺀 폭에 페이지 폭, 최대 1.25·최소 minScale', () => {
  const ins = { top: 0, right: 0, bottom: 88, left: 0 };
  assert.equal(fitScaleFor({ w: 834, h: 1100, insets: ins }, 720, 0.3), (834 - 32) / 720);
  assert.equal(fitScaleFor({ w: 1194, h: 774, insets: { top: 0, right: 0, bottom: 0, left: 84 } }, 720, 0.3), 1.25);
  assert.equal(fitScaleFor({ w: 200, h: 900, insets: ins }, 720, 0.3), 0.3);
});

test('화면 돌리기: 보던 가운데 월드 점이 새 화면 가운데로, 폭 맞춤이었으면 새 폭에 다시 맞춤', () => {
  const portrait = { w: 834, h: 1134, insets: { top: 0, right: 0, bottom: 88, left: 0 } };
  const landscape = { w: 1194, h: 774, insets: { top: 0, right: 0, bottom: 0, left: 84 } };
  const fit = { pageW: 720, minScale: 0.3, maxScale: 1.25 };
  const s0 = fitScaleFor(portrait, 720, 0.3);
  // 3쪽(월드 y ≈ 2400)을 보는 중
  const v0 = { scale: s0, tx: 16, ty: 523 - 2400 * s0 };
  const wc = (v, b) => {
    const I = b.insets;
    return [((I.left + (b.w - I.left - I.right) / 2) - v.tx) / v.scale, ((I.top + (b.h - I.top - I.bottom) / 2) - v.ty) / v.scale];
  };
  const before = wc(v0, portrait);
  const v1 = anchorView(v0, portrait, landscape, fit);
  assert.equal(v1.scale, 1.25, '가로 폭에 다시 맞춤');
  const after = wc(v1, landscape);
  assert.ok(Math.abs(after[0] - before[0]) < 1e-6 && Math.abs(after[1] - before[1]) < 1e-6, `가운데 점 유지 ${before} → ${after}`);
  // 다시 세로로: 처음 화면 그대로
  const v2 = anchorView(v1, landscape, portrait, fit);
  assert.ok(Math.abs(v2.scale - v0.scale) < 1e-9 && Math.abs(v2.tx - v0.tx) < 1e-6 && Math.abs(v2.ty - v0.ty) < 1e-6, '왕복하면 제자리');
});

test('화면 돌리기: 직접 확대해 둔 배율은 지킨다', () => {
  const a = { w: 834, h: 1134, insets: { top: 0, right: 0, bottom: 88, left: 0 } };
  const b = { w: 1194, h: 774, insets: { top: 0, right: 0, bottom: 0, left: 84 } };
  const v = anchorView({ scale: 2.5, tx: -300, ty: -900 }, a, b, { pageW: 720, minScale: 0.3, maxScale: 1.25 });
  assert.equal(v.scale, 2.5);
  // fit 정보 없이(무한 캔버스) — 배율 유지, 가운데만 옮김
  assert.equal(anchorView({ scale: 1.1, tx: 0, ty: 0 }, a, b).scale, 1.1);
});

test('키보드 가림: visualViewport 가 줄어든 만큼 아래, 밀려 올라간 만큼 위', () => {
  assert.deepEqual(keyboardInsets({ innerHeight: 834 }), { top: 0, bottom: 0 }, 'visualViewport 없음');
  assert.deepEqual(keyboardInsets({ innerHeight: 834, vvHeight: 834, vvTop: 0, vvScale: 1 }), { top: 0, bottom: 0 });
  assert.deepEqual(keyboardInsets({ innerHeight: 834, vvHeight: 434, vvTop: 0, vvScale: 1 }), { top: 0, bottom: 400 });
  assert.deepEqual(keyboardInsets({ innerHeight: 834, vvHeight: 434, vvTop: 120, vvScale: 1 }), { top: 120, bottom: 280 }, 'iOS 가 화면을 밀어 올린 경우');
  assert.deepEqual(keyboardInsets({ innerHeight: 834, vvHeight: 834 - KB_MIN_PX + 1, vvTop: 0 }), { top: 0, bottom: 0 }, '몇 px 차이는 무시');
  assert.deepEqual(keyboardInsets({ innerHeight: 834, vvHeight: 417, vvTop: 200, vvScale: 2 }), { top: 0, bottom: 0 }, '핀치 확대는 키보드가 아님');
});

test('키보드 가림: 수식 화면 키보드(MathLive) 높이도 더한다 — 둘 중 큰 쪽', () => {
  assert.deepEqual(keyboardInsets({ innerHeight: 834, vvHeight: 834, vvTop: 0, mathKeyboard: 310.4 }), { top: 0, bottom: 310 });
  assert.deepEqual(keyboardInsets({ innerHeight: 834, vvHeight: 434, vvTop: 0, mathKeyboard: 300 }), { top: 0, bottom: 400 });
  assert.deepEqual(keyboardInsets({ innerHeight: 834, mathKeyboard: 300 }), { top: 0, bottom: 300 });
});

test('도구 막대: 넓으면 모두, 좁으면 44px 버튼 + 더보기 (펜·지우개·올가미·실행 취소 먼저)', () => {
  assert.deepEqual(paletteLayout(Infinity), { compact: false, shown: PAL_ORDER, more: [] });
  assert.deepEqual(paletteLayout(PAL_FULL_PX), { compact: false, shown: PAL_ORDER, more: [] });
  // 320 폭 Split View (막대 쓸 길이 296)
  const n320 = paletteLayout(296);
  assert.equal(n320.compact, true);
  assert.deepEqual(n320.shown, ['pen', 'eraser', 'lasso', 'ink', 'undo'], '막대 순서대로');
  assert.deepEqual(n320.more, ['highlighter', 'text', 'shape', 'insert', 'redo', 'touch']);
  assert.ok(compactLength(n320.shown.length + 1) <= 296, '더보기 포함 화면 안');
  // 모든 폭에서: 화면 안, 빠지는 것 없음
  for (let room = 100; room < PAL_FULL_PX; room += 7) {
    const l = paletteLayout(room);
    const buttons = l.shown.length + (l.more.length ? 1 : 0);
    if (room >= 104) assert.ok(compactLength(buttons) <= room, `${room}: ${compactLength(buttons)}`);
    assert.deepEqual([...l.shown, ...l.more].sort(), [...PAL_ORDER].sort(), `${room}: 모두 있다`);
    assert.ok(l.shown.includes('pen'), '펜은 늘 막대에');
  }
  // 줄인 버튼 11개가 다 들어가면 더보기 없음
  const all = paletteLayout(compactLength(11));
  assert.deepEqual(all.more, []);
  assert.equal(all.compact, true);
});
