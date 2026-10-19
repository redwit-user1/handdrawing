import { test } from 'node:test';
import assert from 'node:assert/strict';

// 엔진(js/engine.js)은 모듈이 아닌 스크립트라 window 에 붙는다 — 그리기 없이 종이 표만 확인한다
globalThis.window = globalThis.window ?? {};
await import('../../../js/engine.js');
const HD = globalThis.window.HandDrawing;

test('종이 목록: 기본 모눈이 맨 앞, 7가지, id 는 겹치지 않는다', () => {
  const ids = HD.PAPERS.map((p) => p.id);
  assert.deepEqual(ids, ['grid', 'grid-5mm', 'grid-10mm', 'engineering', 'lined', 'dots', 'blank']);
  assert.equal(HD.PAPER_DEFAULT, 'grid');
  for (const p of HD.PAPERS) assert.ok(p.name && typeof p.name === 'string');
});

test('기본 모눈은 지금 모양 그대로 (24 간격 격자)', () => {
  const s = HD.paperSpec(undefined);
  assert.equal(s.id, 'grid');
  assert.equal(s.kind, 'grid');
  assert.equal(s.step, 24);
  assert.equal(s.major, undefined);
});

test('mm 모눈은 페이지 폭(720 = 본문 180mm, 1mm = 4)에 맞춘 간격', () => {
  assert.equal(HD.paperSpec('grid-5mm').step, 20);
  assert.equal(HD.paperSpec('grid-10mm').step, 40);
  const eng = HD.paperSpec('engineering');
  assert.equal(eng.kind, 'grid');
  assert.equal(eng.major, 5);
  assert.equal(HD.paperSpec('lined').kind, 'lines');
  assert.equal(HD.paperSpec('dots').kind, 'dots');
  assert.equal(HD.paperSpec('blank').kind, 'blank');
});

test('모르는 id·빈 값·문자열 아님 → 기본 모눈으로 그린다', () => {
  for (const v of ['nope', '', null, 42, {}, 'GRID']) assert.equal(HD.paperSpec(v).id, 'grid', String(v));
});

test('레이아웃 정규화: paper 가 없으면 키도 없다 (옛 노트 data·sha 그대로)', () => {
  const l = HD.normalizePageLayout({ type: 'pages', pageW: 720, pageH: 1068, gap: 28, date: '2026-09-29' });
  assert.equal('paper' in l, false);
});

test('레이아웃 정규화: 아는 종이는 남기고, 모르는 종이도 형식이 맞으면 남긴다(다음 판 호환), 이상한 값은 버린다', () => {
  assert.equal(HD.normalizePageLayout({ type: 'pages', paper: 'dots' }).paper, 'dots');
  assert.equal(HD.normalizePageLayout({ type: 'pages', paper: 'future-paper' }).paper, 'future-paper');
  for (const v of [42, '', 'x'.repeat(40), '<b>', 'Dots ']) assert.equal('paper' in HD.normalizePageLayout({ type: 'pages', paper: v }), false, String(v));
});

test('새 노트 레이아웃: 기본 모눈이면 paper 를 넣지 않고, 다른 종이면 넣는다', () => {
  assert.deepEqual(Object.keys(HD.defaultPageLayout('2026-10-19')), ['type', 'pageW', 'pageH', 'gap', 'date']);
  assert.equal('paper' in HD.defaultPageLayout('2026-10-19', 'grid'), false);
  assert.equal(HD.defaultPageLayout('2026-10-19', 'lined').paper, 'lined');
  assert.equal('paper' in HD.defaultPageLayout('2026-10-19', 'nope'), false);
});
