import { test } from 'node:test';
import assert from 'node:assert/strict';

// 엔진(js/engine.js)은 모듈이 아닌 스크립트라 window 에 붙는다 — 손가락 입력 판정(순수 함수)만 확인한다
globalThis.window = globalThis.window ?? {};
await import('../../../js/engine.js');
const { fingerDownAction, touchIntent, TOUCH_TAP_SLOP, TOUCH_TAP_MS } = globalThis.window.HandDrawing.input;

test('손가락 판정 기준: 10px 안에서 0.5초 안에 떼면 탭', () => {
  assert.equal(TOUCH_TAP_SLOP, 10);
  assert.equal(TOUCH_TAP_MS, 500);
});

test('손가락이 닿으면: 손가락으로 쓰기 꺼짐 → 선택 안이면 옮기기, 아니면 탭/넘기기 판정', () => {
  for (const tool of ['pen', 'highlighter', 'eraser', 'shape', 'lasso', 'text']) {
    assert.equal(fingerDownAction({ tool, touchDraws: false }), 'tap', tool);
    assert.equal(fingerDownAction({ tool, touchDraws: false, inSelection: true }), 'move', tool);
  }
});

test('손가락으로 쓰기 켜짐 → 손가락도 지금 도구 그대로 (예전과 같다)', () => {
  for (const tool of ['pen', 'lasso', 'text', 'eraser']) {
    assert.equal(fingerDownAction({ tool, touchDraws: true }), 'tool', tool);
    assert.equal(fingerDownAction({ tool, touchDraws: true, inSelection: true }), 'tool', tool);
  }
});

test('읽기 전용·이동 도구 → 언제나 화면 넘기기', () => {
  assert.equal(fingerDownAction({ readonly: true, tool: 'pen', touchDraws: true }), 'pan');
  assert.equal(fingerDownAction({ readonly: true, tool: 'lasso', touchDraws: false, inSelection: true }), 'pan');
  assert.equal(fingerDownAction({ tool: 'pan', touchDraws: false, inSelection: true }), 'pan');
  assert.equal(fingerDownAction({ tool: 'pan', touchDraws: true }), 'pan');
});

test('움직임 판정: 10px 넘게 움직이면 바로 넘기기, 그 안이면 뗄 때까지 보류', () => {
  assert.equal(touchIntent(0, 0, false), 'pending');
  assert.equal(touchIntent(10, 50, false), 'pending');
  assert.equal(touchIntent(10.5, 50, false), 'pan');
  assert.equal(touchIntent(40, 2000, true), 'pan');
});

test('뗄 때: 짧게 누르면 탭, 오래 누르면 아무것도 안 함', () => {
  assert.equal(touchIntent(0, 80, true), 'tap');
  assert.equal(touchIntent(9, 500, true), 'tap');
  assert.equal(touchIntent(3, 501, true), 'hold');
  assert.equal(touchIntent(3, 1500, true), 'hold');
});
