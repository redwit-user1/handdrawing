/**
 * 앱에 내장할 정적 자산 복사 — 오프라인에서도 동작하도록 CDN 대신 앱 안에서 내준다.
 *   mathlive 글꼴 → public/mathlive/fonts (수식 입력기)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(appDir, 'node_modules', 'mathlive', 'fonts');
const dst = path.join(appDir, 'public', 'mathlive', 'fonts');
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
console.log(`[assets] mathlive fonts → ${path.relative(appDir, dst)} (${fs.readdirSync(dst).length} files)`);
