/**
 * 앱에 내장할 편집기 자산을 public/ 아래로 복사한다 (앱은 서버 없이 이 파일들로 동작).
 *
 *  - editor-ai standalone 번들 → public/vendor/editor-ai/
 *      기본 원본: ../../NewEditor/packages/editor-ai/dist/standalone
 *      (NEWEDITOR_STANDALONE_DIR 로 변경. NewEditor 에서 `npm -w @redwit/editor-ai run build:standalone` 선행)
 *  - handdrawing(이 저장소 루트) → public/handdrawing/
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appDir, '..');
const editorSrc = path.resolve(process.env.NEWEDITOR_STANDALONE_DIR
  || path.join(repoRoot, '..', 'NewEditor', 'packages', 'editor-ai', 'dist', 'standalone'));

function copyDir(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
}

if (!fs.existsSync(path.join(editorSrc, 'editor-ai.standalone.js'))) {
  console.error(`[vendor] editor-ai standalone 번들이 없습니다: ${editorSrc}
  NewEditor 저장소에서 먼저 빌드하세요: npm install && npm -w @redwit/editor-ai run build:standalone
  다른 위치라면 NEWEDITOR_STANDALONE_DIR 환경 변수로 지정하세요.`);
  process.exit(1);
}
copyDir(editorSrc, path.join(appDir, 'public', 'vendor', 'editor-ai'));

const hdDst = path.join(appDir, 'public', 'handdrawing');
fs.rmSync(hdDst, { recursive: true, force: true });
fs.mkdirSync(path.join(hdDst, 'js'), { recursive: true });
for (const f of ['index.html', 'config.js', 'styles.css', 'icon.svg']) {
  fs.copyFileSync(path.join(repoRoot, f), path.join(hdDst, f));
}
for (const f of fs.readdirSync(path.join(repoRoot, 'js'))) {
  if (f.endsWith('.js')) fs.copyFileSync(path.join(repoRoot, 'js', f), path.join(hdDst, 'js', f));
}
console.log(`[vendor] editor-ai ← ${editorSrc}\n[vendor] handdrawing ← ${repoRoot}`);
