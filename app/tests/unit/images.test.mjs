import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { contentHash, editorToStored, refsIn, storedToEditor, storedToUpload } from '../../src/lib/images.ts';

const R1 = '0b6e0e7e-0000-4000-8000-000000000001';
const R2 = '0b6e0e7e-0000-4000-8000-000000000002';
const stored = `<p>본문</p><figure class="rw-drawing" data-strokes="{}"><img src="hdimg:${R2}"><img src="hdimg:${R1}"></figure><img src="hdimg:${R1}">`;

test('참조 추출·변환 왕복', () => {
  assert.deepEqual(refsIn(stored).sort(), [R1, R2].sort());
  const urls = { [R1]: 'blob:http://localhost/aaa', [R2]: 'blob:http://localhost/bbb' };
  const editor = storedToEditor(stored, (r) => urls[r]);
  assert.ok(!editor.includes('hdimg:'));
  const back = editorToStored(editor + '<img src="blob:http://localhost/unknown">', (u) => Object.keys(urls).find((k) => urls[k] === u));
  assert.equal(back, stored + '<img src="blob:http://localhost/unknown">', '모르는 blob: 주소는 그대로');
  assert.equal(storedToUpload(stored).match(/blob:goono-app\//g).length, 3);
});

test('내용 해시가 서버(모의 서버) 규칙과 같다', async () => {
  const html = storedToUpload(stored);
  const imgs = [{ ref: R2, bytes: new Uint8Array([9, 8, 7]) }, { ref: R1, bytes: new Uint8Array([1, 2, 3]) }];
  const h = crypto.createHash('sha256');
  h.update(Buffer.from(html, 'utf8'));
  for (const img of [...imgs].sort((a, b) => (a.ref < b.ref ? -1 : 1))) {
    h.update(Buffer.from(`\n${img.ref}:${crypto.createHash('sha256').update(img.bytes).digest('hex')}`, 'utf8'));
  }
  assert.equal(await contentHash(html, imgs), h.digest('hex'));
  assert.notEqual(await contentHash(html, imgs), await contentHash(html + ' ', imgs));
});
