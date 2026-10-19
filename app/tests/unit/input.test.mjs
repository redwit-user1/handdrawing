import { test } from 'node:test';
import assert from 'node:assert/strict';

// 엔진(js/engine.js)은 모듈이 아닌 스크립트라 window 에 붙는다 — 손가락 입력 판정(순수 함수)만 확인한다
globalThis.window = globalThis.window ?? {};
await import('../../../js/engine.js');
const { fingerDownAction, fingerOutcome, isPalmSuspect, touchIntent, TOUCH_TAP_SLOP, TOUCH_TAP_MS, PEN_GUARD_MS, PALM_CONTACT_PX } =
  globalThis.window.HandDrawing.input;

test('판정 기준: 10px·0.5초 탭, 펜 뒤 1.5초는 손바닥 의심, 닿은 면 40px', () => {
  assert.equal(TOUCH_TAP_SLOP, 10);
  assert.equal(TOUCH_TAP_MS, 500);
  assert.equal(PEN_GUARD_MS, 1500);
  assert.equal(PALM_CONTACT_PX, 40);
});

test('손가락이 닿으면: 손가락으로 쓰기 꺼짐 → 움직임을 보고 정한다, 켜짐 → 지금 도구 그대로 (예전과 같다)', () => {
  for (const tool of ['pen', 'highlighter', 'eraser', 'shape', 'lasso', 'text']) {
    assert.equal(fingerDownAction({ tool, touchDraws: false }), 'finger', tool);
    assert.equal(fingerDownAction({ tool, touchDraws: true }), 'tool', tool);
  }
});

test('읽기 전용·이동 도구 → 언제나 화면 넘기기', () => {
  assert.equal(fingerDownAction({ readonly: true, tool: 'pen', touchDraws: true }), 'pan');
  assert.equal(fingerDownAction({ readonly: true, tool: 'lasso', touchDraws: false }), 'pan');
  assert.equal(fingerDownAction({ tool: 'pan', touchDraws: false }), 'pan');
  assert.equal(fingerDownAction({ tool: 'pan', touchDraws: true }), 'pan');
});

test('움직임 판정: 10px 넘게 움직이면 바로 넘기기, 그 안이면 뗄 때까지 보류', () => {
  assert.equal(touchIntent(0, 0, false), 'pending');
  assert.equal(touchIntent(10, 50, false), 'pending');
  assert.equal(touchIntent(10.5, 50, false), 'pan');
  assert.equal(touchIntent(40, 2000, true), 'pan');
  assert.equal(touchIntent(0, 80, true), 'tap');
  assert.equal(touchIntent(9, 500, true), 'tap');
  assert.equal(touchIntent(3, 501, true), 'hold');
});

test('선택 영역 안: 10px 안의 흔들림은 옮기지 않는다(탭 = 선택 유지), 넘으면 옮기기', () => {
  for (const dist of [0, 1, 5, 9, 10]) {
    assert.equal(fingerOutcome({ dist, ms: 0, ended: false, inSelection: true }), 'pending', `누르는 중 ${dist}px`);
    assert.equal(fingerOutcome({ dist, ms: 120, ended: true, inSelection: true }), 'keep', `뗌 ${dist}px`);
  }
  assert.equal(fingerOutcome({ dist: 11, ms: 0, ended: false, inSelection: true }), 'move');
});

test('선택 영역 밖: 탭 → 지금 도구의 탭, 끌기 → 넘기기, 오래 누름 → 아무것도 안 함', () => {
  assert.equal(fingerOutcome({ dist: 3, ms: 100, ended: true }), 'tap');
  assert.equal(fingerOutcome({ dist: 30, ms: 0, ended: false }), 'pan');
  assert.equal(fingerOutcome({ dist: 3, ms: 900, ended: true }), 'none');
});

test('손바닥 의심: 탭도 옮기기도 하지 않고 넘기기만', () => {
  assert.equal(fingerOutcome({ dist: 2, ms: 100, ended: true, palm: true }), 'none');
  assert.equal(fingerOutcome({ dist: 2, ms: 100, ended: true, inSelection: true, palm: true }), 'none');
  assert.equal(fingerOutcome({ dist: 30, ms: 0, ended: false, inSelection: true, palm: true }), 'pan');
  assert.equal(fingerOutcome({ dist: 30, ms: 0, ended: false, palm: true }), 'pan');
});

test('손바닥 의심 조건: 펜이 닿아 있음 / 펜 뒤 1.5초 안 / 닿은 뒤 펜 움직임 / 넓은 면(값이 있을 때만)', () => {
  assert.equal(isPalmSuspect({}), false);
  assert.equal(isPalmSuspect({ penDown: true }), true);
  assert.equal(isPalmSuspect({ sincePen: 700 }), true);
  assert.equal(isPalmSuspect({ sincePen: 1499 }), true);
  assert.equal(isPalmSuspect({ sincePen: 1500 }), false);
  assert.equal(isPalmSuspect({ sincePen: 60_000, penAfterTouch: true }), true);
  assert.equal(isPalmSuspect({ width: 60, height: 20 }), true);
  assert.equal(isPalmSuspect({ width: 20, height: 45 }), true);
  assert.equal(isPalmSuspect({ width: 22, height: 22 }), false);
  assert.equal(isPalmSuspect({ width: 1, height: 1 }), false);
  assert.equal(isPalmSuspect({ width: 0, height: 0 }), false);
});
