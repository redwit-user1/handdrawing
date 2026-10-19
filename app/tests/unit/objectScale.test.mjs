import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chemFit, madeSize, svgFromDataUrl, svgSize, TEX_OVERSAMPLE, userScale } from '../../src/notebook/objectScale.ts';

const b64 = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
const MATH = b64('<svg xmlns="http://www.w3.org/2000/svg" width="300.0" height="66.0" viewBox="0 -800 5000 1100"><g>수식</g></svg>');
const CHEM = b64('<svg xmlns="http://www.w3.org/2000/svg" width="400px" height="200px"><g/></svg>');

test('SVG data URL 읽기: base64·UTF-8, width/height 또는 viewBox', () => {
  assert.match(svgFromDataUrl(MATH), /수식/);
  assert.equal(svgFromDataUrl('data:image/jpeg;base64,AAAA'), null);
  assert.deepEqual(svgSize(svgFromDataUrl(CHEM)), { w: 400, h: 200 });
  assert.deepEqual(svgSize('<svg viewBox="0 0 120 40"></svg>'), { w: 120, h: 40 });
  assert.equal(svgSize('<svg></svg>'), null);
});

test('처음 만든 크기: 수식·화학식 = SVG ÷ 3, 구조식 = 360×280 안으로 줄인 크기', () => {
  assert.equal(TEX_OVERSAMPLE, 3);
  assert.deepEqual(madeSize('math', MATH), { w: 100, h: 22 });
  assert.deepEqual(madeSize('ce', MATH), { w: 100, h: 22 });
  assert.deepEqual(chemFit(400, 200), { w: 360, h: 180 });
  assert.deepEqual(madeSize('chem', CHEM), { w: 360, h: 180 });
  assert.equal(madeSize(undefined, MATH), null);
});

test('다시 고칠 때 배율: 손잡이로 2배로 키운 수식은 2, 반으로 줄인 구조식은 0.5, 모르면 1', () => {
  assert.equal(userScale({ kind: 'math', src: MATH, points: [[10, 10], [210, 54]] }), 2);
  assert.equal(userScale({ kind: 'chem', src: CHEM, points: [[0, 0], [180, 90]] }), 0.5);
  assert.equal(userScale({ kind: 'math', src: MATH, points: [[0, 0], [100, 22]] }), 1);
  assert.equal(userScale({ kind: 'math', src: 'data:image/png;base64,AA', points: [[0, 0], [50, 10]] }), 1);
  assert.equal(userScale({ kind: 'math', src: MATH, points: [[0, 0], [0, 0]] }), 1); // 이상한 값은 무시
});
