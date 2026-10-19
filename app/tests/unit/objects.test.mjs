import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeSelectionBar, BAR_GAP } from '../../src/notebook/selectionBar.ts';

// 엔진(js/engine.js)은 모듈이 아닌 스크립트라 window 에 붙는다 — 객체 크기·자리·손잡이 계산(순수 함수)만 확인한다
globalThis.window = globalThis.window ?? {};
await import('../../../js/engine.js');
const HD = globalThis.window.HandDrawing;
const G = HD.geom;
const { fingerOutcome } = HD.input;
const L = HD.normalizePageLayout(HD.defaultPageLayout()); // 720 × 1068, 틈 28
const STRIDE = L.pageH + L.gap;
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const inPage = (b, i) => b.x >= 0 && b.x + b.w <= L.pageW && b.y >= i * STRIDE && b.y + b.h <= i * STRIDE + L.pageH;

test('페이지 본문: 좌우 24, 머리글(44) 아래 12, 페이지 아래 12 — 폭 672, 높이 1000', () => {
  assert.equal(L.pageW, 720);
  assert.equal(L.pageH, 1068);
  assert.deepEqual(G.pageBodyRect(L, 0), { x: 24, y: 56, w: 672, h: 1000 });
  assert.deepEqual(G.pageBodyRect(L, 2), { x: 24, y: 2 * STRIDE + 56, w: 672, h: 1000 });
});

test('새 사진 크기: 본문 폭의 60%(비율 그대로), 화면 배율과 무관 — 본문보다 크면 줄이고, 원본보다 키우지 않는다', () => {
  assert.deepEqual(G.initialImageSize(L, 1600, 1067), { w: 403.2, h: 268.88 });
  const wide = G.initialImageSize(L, 1600, 120);
  assert.equal(wide.w, 403.2);
  const tall = G.initialImageSize(L, 200, 1600);   // 60% 폭이면 높이가 본문을 넘는다 → 높이 1000 에 맞춤
  assert.equal(tall.h, 125 * 8);
  assert.ok(near(tall.w / tall.h, 200 / 1600));
  assert.deepEqual(G.initialImageSize(L, 120, 80), { w: 120, h: 80 }); // 작은 그림은 그대로
  // 수식·구조식(kind)은 만든 크기 그대로, 본문을 넘으면 줄인다
  assert.deepEqual(G.initialImageSize(L, 220, 48, false), { w: 220, h: 48 });
  const big = G.initialImageSize(L, 1344, 100, false);
  assert.equal(big.w, 672);
  assert.equal(big.h, 50);
});

test('가장 많이 담은 페이지: 걸치면 많이 담은 쪽, 반반이면 아래, 틈에만 있으면 위, 위쪽 밖은 첫 페이지', () => {
  assert.equal(G.pageIndexOfBox(L, { x: 0, y: 100, w: 10, h: 10 }), 0);
  assert.equal(G.pageIndexOfBox(L, { x: 0, y: L.pageH - 200, w: 10, h: 300 }), 0);           // 200 vs 72
  assert.equal(G.pageIndexOfBox(L, { x: 0, y: L.pageH - 50, w: 10, h: 300 }), 1);            // 50 vs 222
  assert.equal(G.pageIndexOfBox(L, { x: 0, y: L.pageH - 50, w: 10, h: 128 }), 1);            // 50 vs 50 → 아래
  assert.equal(G.pageIndexOfBox(L, { x: 0, y: L.pageH + 5, w: 10, h: 10 }), 0);              // 틈
  assert.equal(G.pageIndexOfBox(L, { x: 0, y: -40, w: 10, h: 20 }), 0);
});

test('페이지 맞추기: 페이지 안이면 그대로(여백·머리글 위 포함), 걸친 방향만 본문 안으로', () => {
  assert.deepEqual(G.snapBoxIntoPage(L, { x: 4, y: 10, w: 100, h: 50 }), { dx: 0, dy: 0, page: 0 });
  // 오른쪽 끝을 넘음 → 본문 오른쪽(696)에 맞춤, 세로는 그대로
  assert.deepEqual(G.snapBoxIntoPage(L, { x: 650, y: 300, w: 100, h: 50 }), { dx: -54, dy: 0, page: 0 });
  // 왼쪽 밖 → 본문 왼쪽(24)
  assert.deepEqual(G.snapBoxIntoPage(L, { x: -30, y: 300, w: 100, h: 50 }), { dx: 54, dy: 0, page: 0 });
  // 아래로 걸쳤는데 대부분 1쪽 → 1쪽 본문 아래(1056)로 올림
  const up = G.snapBoxIntoPage(L, { x: 100, y: 900, w: 200, h: 200 });
  assert.deepEqual(up, { dx: 0, dy: 1056 - 1100, page: 0 });
  // 대부분 2쪽 → 2쪽 본문 맨 위(STRIDE + 56)로 내림
  const down = G.snapBoxIntoPage(L, { x: 100, y: L.pageH - 40, w: 200, h: 200 });
  assert.deepEqual(down, { dx: 0, dy: STRIDE + 56 - (L.pageH - 40), page: 1 });
  // 위쪽 밖 → 1쪽 본문 맨 위
  assert.deepEqual(G.snapBoxIntoPage(L, { x: 100, y: -20, w: 50, h: 50 }), { dx: 0, dy: 76, page: 0 });
  // 본문보다 높지만 페이지보다 낮으면 페이지 안에서, 페이지보다 크면 그 방향은 그대로
  const tall = G.snapBoxIntoPage(L, { x: 100, y: 500, w: 50, h: 1040 });
  assert.ok(inPage({ x: 100, y: 500 + tall.dy, w: 50, h: 1040 }, tall.page));
  assert.deepEqual(G.snapBoxIntoPage(L, { x: -10, y: 500, w: 800, h: 50 }), { dx: 0, dy: 0, page: 0 });
  // 맞춘 결과는 늘 페이지 안
  for (const b of [{ x: 690, y: 1000, w: 300, h: 200 }, { x: -100, y: 2100, w: 400, h: 400 }, { x: 300, y: 3270, w: 100, h: 100 }]) {
    const s = G.snapBoxIntoPage(L, b);
    assert.ok(inPage({ x: b.x + s.dx, y: b.y + s.dy, w: b.w, h: b.h }, s.page), JSON.stringify([b, s]));
  }
});

test('손잡이 잡기: 모서리 반지름 22px(상자 밖), 상자 안에서는 짧은 변의 1/3 까지만 — 작은 객체도 옮길 수 있게', () => {
  assert.equal(G.HANDLE_HIT_PX, 22);
  const box = { x: 100, y: 100, w: 300, h: 200 };
  assert.deepEqual(G.boxCorners(box).map((c) => c[0]), ['nw', 'ne', 'sw', 'se']);
  assert.equal(G.handleAt(box, 100, 100), 'nw');
  assert.equal(G.handleAt(box, 85, 85), 'nw');        // 밖 21px
  assert.equal(G.handleAt(box, 84, 84), null);        // 밖 22.6px
  assert.equal(G.handleAt(box, 415, 315), 'se');
  assert.equal(G.handleAt(box, 400, 100), 'ne');
  assert.equal(G.handleAt(box, 112, 290), 'sw');      // 안쪽 15px
  assert.equal(G.handleAt(box, 250, 200), null);      // 가운데
  const small = { x: 0, y: 0, w: 40, h: 30 };         // 작은 객체: 안쪽은 10px 까지만
  assert.equal(G.handleAt(small, 20, 15), null);
  assert.equal(G.handleAt(small, 6, 6), 'nw');
  assert.equal(G.handleAt(small, -12, -12), 'nw');
});

test('크기 바꾸기(비율 고정): 반대쪽 모서리는 그대로, 비율 유지, 최소 크기, 한계(본문) 안, 뒤집히지 않음', () => {
  const s = { x: 100, y: 100, w: 300, h: 200 };
  const r = G.resizeBox(s, 'se', 60, 40);
  assert.ok(near(r.x, 100) && near(r.y, 100) && near(r.w, 360) && near(r.h, 240));
  const r2 = G.resizeBox(s, 'nw', 30, 20);   // 왼쪽 위를 안쪽으로 → 줄어듦, 오른쪽 아래 고정
  assert.ok(near(r2.x + r2.w, 400) && near(r2.y + r2.h, 300) && near(r2.w / r2.h, 1.5) && near(r2.w, 270));
  const r3 = G.resizeBox(s, 'ne', 100, 0);   // 대각선 투영 → 비율 유지
  assert.ok(near(r3.w / r3.h, 1.5) && near(r3.x, 100) && near(r3.y + r3.h, 300));
  const tiny = G.resizeBox(s, 'se', -1000, -1000);
  assert.ok(near(tiny.h, 16) && near(tiny.w, 24) && near(tiny.x, 100), JSON.stringify(tiny));
  const bounds = { x: 24, y: 56, w: 672, h: 1000 };
  const big = G.resizeBox(s, 'se', 2000, 2000, { bounds });
  assert.ok(near(big.x + big.w, 696) && near(big.w / big.h, 1.5), JSON.stringify(big));
  const bigNw = G.resizeBox(s, 'nw', -500, -500, { bounds });
  assert.ok(near(bigNw.x, 24) || near(bigNw.y, 56));
  assert.ok(bigNw.x >= 24 - 0.01 && bigNw.y >= 56 - 0.01);
});

test('크기 바꾸기(폭만 — 글상자·표): 높이·위쪽은 그대로, 최소 폭', () => {
  const s = { x: 100, y: 100, w: 300, h: 50 };
  const r = G.resizeBox(s, 'se', 80, 500, { aspect: false, minW: 80 });
  assert.deepEqual(r, { x: 100, y: 100, w: 380, h: 50 });
  const l = G.resizeBox(s, 'nw', 50, -90, { aspect: false, minW: 80 });
  assert.deepEqual(l, { x: 150, y: 100, w: 250, h: 50 });
  assert.equal(G.resizeBox(s, 'ne', -1000, 0, { aspect: false, minW: 80 }).w, 80);
  assert.equal(G.resizeBox(s, 'se', 1000, 0, { aspect: false, bounds: { x: 24, y: 56, w: 672, h: 1000 } }).w, 596);
});

test('90° 돌리기: 가운데 그대로, 폭·높이 바꿈 / 본문에 맞춰 줄이기', () => {
  assert.deepEqual(G.rotateBox90({ x: 100, y: 100, w: 300, h: 200 }), { x: 150, y: 50, w: 200, h: 300 });
  assert.deepEqual(G.fitSize(400, 1200, 672, 1000), { w: 400 * (1000 / 1200), h: 1000 });
  assert.deepEqual(G.fitSize(300, 200, 672, 1000), { w: 300, h: 200 });
});

test('손가락: 손잡이에서 10px 넘게 끌면 크기 바꾸기, 손바닥 의심이면 넘기기, 손잡이 탭은 선택 유지', () => {
  assert.equal(fingerOutcome({ dist: 11, ms: 0, ended: false, onHandle: true }), 'resize');
  assert.equal(fingerOutcome({ dist: 11, ms: 0, ended: false, onHandle: true, inSelection: true }), 'resize');
  assert.equal(fingerOutcome({ dist: 11, ms: 0, ended: false, onHandle: true, palm: true }), 'pan');
  assert.equal(fingerOutcome({ dist: 5, ms: 0, ended: false, onHandle: true }), 'pending');
  assert.equal(fingerOutcome({ dist: 3, ms: 100, ended: true, onHandle: true }), 'keep');
  assert.equal(fingerOutcome({ dist: 3, ms: 100, ended: true, onHandle: true, palm: true }), 'none');
  // 손잡이가 아니면 T1 과 같다
  assert.equal(fingerOutcome({ dist: 11, ms: 0, ended: false, inSelection: true }), 'move');
  assert.equal(fingerOutcome({ dist: 11, ms: 0, ended: false }), 'pan');
});

test('선택 막대 자리: 선택 바로 위 → 자리 없으면 아래 → 그것도 없으면 보이는 곳 맨 위, 가로는 가운데·화면 안', () => {
  const view = { w: 1000, h: 800 }, bar = { w: 300, h: 58 }, none = { top: 0, right: 0, bottom: 0, left: 0 };
  assert.equal(BAR_GAP, 28);
  assert.deepEqual(placeSelectionBar({ x: 400, y: 300, w: 200, h: 100 }, bar, view, none), { x: 350, y: 300 - 28 - 58 });
  assert.deepEqual(placeSelectionBar({ x: 400, y: 40, w: 200, h: 100 }, bar, view, none), { x: 350, y: 140 + 28 });
  assert.deepEqual(placeSelectionBar({ x: 0, y: 20, w: 1000, h: 760 }, bar, view, none), { x: 350, y: 8 });
  // 왼쪽 끝 선택 + 왼쪽 도구 막대(84) → 막대는 도구 막대 오른쪽부터
  assert.deepEqual(placeSelectionBar({ x: 90, y: 300, w: 40, h: 40 }, bar, view, { ...none, left: 84 }), { x: 92, y: 214 });
  // 선택이 화면 아래 밖 → 보이는 곳 아래쪽(아래 도구 막대 88 위)
  assert.deepEqual(placeSelectionBar({ x: 400, y: 2000, w: 200, h: 100 }, bar, view, { ...none, bottom: 88 }), { x: 350, y: 800 - 88 - 8 - 58 });
});

/* ── 리뷰 수정 1회차 ── */
const proto = HD.DrawingEngine.prototype;
const fakeEngine = { layout: L, _inkBox: proto._inkBox };
const snap = (strokes) => proto._snapIntoPage.call(fakeEngine, strokes);
const pen = (pts, size = 4) => ({ tool: 'pen', size, color: '#000', points: pts.map(([x, y]) => [x, y, 0.5]) });
const img = (x, y, w, h) => ({ tool: 'image', size: 0, src: 'x', points: [[x, y], [x + w, y + h]] });

test('두 페이지에 걸쳐 고른 필기를 조금 옮겨도(잘리는 것 없음) 한 페이지로 몰리지 않는다', () => {
  // 1쪽 아래 필기 + 2쪽 위 필기 — 각각은 자기 페이지 안
  const a = pen([[100, 1000], [200, 1020]]), b = pen([[100, STRIDE + 80], [220, STRIDE + 120]]);
  assert.equal(G.boxCrossesPage(L, proto._inkBox([a])), false);
  assert.equal(G.boxCrossesPage(L, proto._inkBox([b])), false);
  const before = JSON.stringify([a, b]);
  assert.deepEqual(snap([a, b]), { dx: 0, dy: 0 });
  assert.equal(JSON.stringify([a, b]), before, '그대로');
  // 복제처럼 24 옮긴 뒤에도 각각 페이지 안이면 그대로
  for (const s of [a, b]) for (const p of s.points) { p[0] += 24; p[1] += 24; }
  assert.deepEqual(snap([a, b]), { dx: 0, dy: 0 });
});

test('하나라도 페이지 밖으로 걸치면 덩어리째 맞춘다 / 페이지보다 큰 방향만 그대로(다른 방향은 맞춤)', () => {
  const a = img(600, 300, 200, 100); // 오른쪽 끝을 넘음
  const b = pen([[300, 320], [400, 330]]);
  assert.deepEqual(snap([a, b]), { dx: -104, dy: 0 });
  assert.equal(a.points[1][0], 696);
  assert.equal(b.points[0][0], 196);
  // 페이지보다 넓은 그림을 1쪽 아래 경계 너머로(대부분 2쪽) → 가로는 그대로, 세로는 2쪽 본문 맨 위로
  const wide = img(-50, L.pageH - 30, 800, 200);
  const r = snap([wide]);
  assert.equal(r.dx, 0);
  assert.equal(wide.points[0][1], STRIDE + 56);
  // 두 페이지보다 큰 덩어리(세로)에 오른쪽으로 걸친 것이 있으면 가로만 맞춘다
  const top = pen([[100, 100], [690, 110]]), bottom = img(650, STRIDE + 900, 100, 50);
  const r2 = snap([top, bottom]);
  assert.equal(r2.dy, 0);
  assert.ok(r2.dx < 0 && bottom.points[1][0] <= 696 + 0.01);
});
