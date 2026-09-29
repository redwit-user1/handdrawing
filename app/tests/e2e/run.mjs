/**
 * 태블릿 에뮬레이션 E2E — 모의 서버 + 빌드된 앱(dist).
 *
 *   npm run build && npm run test:e2e
 *
 * 앱 자산은 http://localhost:5199 로 가로채 dist/ 에서 바로 내준다(네이티브 앱이 기기 안 자산을 쓰는 것과 같아
 * 오프라인 전환 중에도 앱은 뜬다). 서버(모의 구노)만 오프라인 전환의 영향을 받는다.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..', '..');
const dist = path.join(appDir, 'dist');
const out = path.join(here, 'out');
fs.mkdirSync(out, { recursive: true });

const PORT = Number(process.env.MOCK_PORT || 8799);
const MOCK = `http://localhost:${PORT}`;
const APP = 'http://localhost:5199'; // localhost = 보안 컨텍스트(WebCrypto 사용 가능), 앱의 https://localhost·capacitor://localhost 와 같은 조건
const EXE = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/ 가 없습니다. 먼저 npm run build');
  process.exit(1);
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };

// ── 모의 서버 ──
const mock = spawn(process.execPath, [path.join(appDir, 'mock-server', 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), IMAGE_DIR: path.join(out, 'images') }, stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  mock.stdout.on('data', (d) => { if (String(d).includes('[mock-eln]')) resolve(); });
  mock.on('exit', (c) => reject(new Error(`mock server exited ${c}`)));
});
const admin = async (p, body) => {
  const r = await fetch(`${MOCK}/__admin${p}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const serverState = async () => (await admin('/state')).body;
await admin('/reset', {});

// ── 검증 도우미 ──
const results = [];
let step = 0;
async function check(name, fn) {
  step++;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ step, name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${step}. ${name}`);
  } catch (e) {
    results.push({ step, name, ok: false, error: String(e?.message ?? e) });
    console.log(`  ✗ ${step}. ${name}\n      ${String(e?.message ?? e).split('\n')[0]}`);
    await page.screenshot({ path: path.join(out, `fail-${step}.png`) }).catch(() => {});
    throw e;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function until(fn, msg, timeout = 15_000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${msg} (시간 초과${last instanceof Error ? `: ${last.message}` : ''})`);
}
const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`) });

// ── 브라우저: iPad 가로(11") 에뮬레이션 ──
// 가로챈(route) 응답으로 뜬 페이지는 주소 공간이 '공용'으로 취급돼 localhost 모의 서버 요청에 Chromium 의
// 로컬 네트워크 접근(LNA) 권한 프롬프트가 걸려 멈춘다 — 헤드리스 테스트에서는 이 검사를 끈다.
const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'],
});
const context = await browser.newContext({
  viewport: { width: 1194, height: 834 },
  deviceScaleFactor: 2,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  locale: 'ko-KR',
  timezoneId: 'Asia/Seoul',
});
await context.route(`${APP}/**`, async (route) => {
  const u = new URL(route.request().url());
  let p = decodeURIComponent(u.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(dist, p);
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: 'not found' });
  return route.fulfill({ status: 200, body: fs.readFileSync(file), contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
});
const page = await context.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

const tid = (id) => page.locator(`[data-testid="${id}"]`);
/** 온라인 표시 — 목록 화면은 동기화 막대, 노트 화면은 상태 알약 */
const netEl = () => page.locator('[data-testid="status-pill"], [data-testid="syncbar"]').first();
const setOffline = async (v) => {
  await context.setOffline(v);
  await until(async () => (await netEl().getAttribute('data-online')) === String(!v), `네트워크 표시 ${v ? '오프라인' : '온라인'}`);
};
const pendingCount = async () => Number(await netEl().getAttribute('data-pending'));
const waitAllSent = () => until(async () => (await pendingCount()) === 0, '올릴 버전 없음', 20_000);
const noteByTitle = async (title) => (await serverState()).notes.find((n) => n.title === title);
const toast = async (re) => {
  let seen = '';
  return until(async () => { const t = await tid('toast').textContent({ timeout: 500 }).catch(() => ''); if (t) seen = t; return re.test(t) && t; }, `알림 ${re}`)
    .catch((e) => { throw new Error(`${e.message} — 마지막 알림: "${seen}"`); });
};
const lockOf = async () => tid('lock-banner').getAttribute('data-lock', { timeout: 300 }).catch(() => '');
const blockOf = async () => tid('block-banner').getAttribute('data-kind', { timeout: 300 }).catch(() => '');
const paletteVisible = async () => (await tid('palette').count()) > 0;

/** 첫 페이지 안쪽 좌표 (페이지는 캔버스 가운데에 놓인다) */
async function pagePoint(x, y) {
  const b = await tid('board').boundingBox();
  return [b.x + b.width * 0.34 + x, b.y + 140 + y];
}
async function newNote(title) {
  await tid('new-note').first().click();
  // 쓸 수 있는 프로젝트가 둘이라 프로젝트를 고르는 대화상자가 뜬다 (제목은 비워 두면 날짜)
  await tid('new-note-dialog').waitFor();
  if (title) await tid('new-note-title').fill(title);
  await tid('new-note-create').click();
  await tid('board').waitFor();
  await tid('palette').waitFor();
}
/** 펜으로 획 몇 개 (마우스 포인터 = 펜처럼 바로 그려진다) */
async function drawStrokes(dy = 0) {
  await tid('tool-pen').click();
  const lines = [[[0, 0], [0, 60]], [[0, 30], [30, 30]], [[30, 0], [30, 60]], [[50, 20], [50, 60]], [[90, 10], [170, 50]], [[90, 50], [170, 10]]];
  for (const [a0, b0] of lines) {
    const a = await pagePoint(a0[0], a0[1] + dy), b = await pagePoint(b0[0], b0[1] + dy);
    await page.mouse.move(a[0], a[1]);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(a[0] + (b[0] - a[0]) * i / 10, a[1] + (b[1] - a[1]) * i / 10);
    await page.mouse.up();
  }
  await waitSaved();
}
/** 글상자에 키보드로 쓰기 */
async function writeText(text, dy = 110) {
  await tid('tool-text').click();
  const p = await pagePoint(0, dy);
  await page.mouse.click(p[0], p[1]);
  await page.locator('textarea.hd-text-input').waitFor();
  await page.keyboard.type(text);
  await tid('tool-pen').click(); // 다른 도구를 누르면 확정
  await waitSaved();
}
/** 글상자를 다시 열어 내용 읽기 */
async function readText(dy = 110) {
  await tid('tool-text').click();
  const p = await pagePoint(4, dy);
  await page.mouse.click(p[0], p[1]);
  const ta = page.locator('textarea.hd-text-input');
  await ta.waitFor();
  const v = await ta.inputValue();
  await page.keyboard.press('Escape');
  await tid('tool-pen').click().catch(() => {});
  return v;
}
async function waitSaved() {
  await until(async () => /기기에 저장됨/.test(await tid('saved-state').textContent()), '작업본 저장');
}
async function saveVersion(expect) {
  await tid('open-versions').click();
  await tid('save-version').click();
  const t = await toast(expect);
  await page.locator('.drawer-head .icon-btn').click();
  return t;
}

const A = '시료 A 600℃ 열처리';
const A2 = '시료 A 600℃ 열처리 (XRD)';
const B = '세포 배양 2일차';
const C = '오프라인에서 만든 노트';
const SECRET = '비밀실험값-7Q3Z';

try {
  console.log(`E2E (앱 ${APP}, 모의 서버 ${MOCK})`);

  await check('로그인(기기 등록)', async () => {
    await page.goto(APP);
    await tid('login-id').fill('researcher1');
    await tid('login-pw').fill('goono1234');
    await tid('login-device').fill('연구실 iPad (E2E)');
    await tid('login-server').fill(MOCK);
    await tid('login-submit').click();
    await tid('new-note').first().waitFor();
    await until(async () => /일 남음/.test(await tid('deadline').textContent()), '오프라인 작성 기한 표시');
    const st = await serverState();
    assert(st.devices.length === 1 && st.devices[0].name === '연구실 iPad (E2E)', '서버에 기기 등록');
  });

  await check('새 노트 → 곧바로 필기 페이지(펜 선택, 키보드 없이), 서버에 노트 생성', async () => {
    await newNote(A);
    assert((await tid('tool-pen').getAttribute('aria-pressed')) === 'true', '펜이 기본 도구');
    assert(await tid('first-hint').isVisible(), '빈 노트 안내');
    assert((await page.locator('textarea, input:focus').count()) === 0, '키보드 입력칸이 열려 있지 않음');
    const n = await until(() => noteByTitle(A), '서버 노트 생성');
    assert(n.editLocation.type === 'DEVICE', '편집 위치 DEVICE');
    await shot('01-new-note');
  });

  await check('오프라인에서 펜 필기 + 글상자 → 버전(기기 대기)', async () => {
    await setOffline(true);
    await drawStrokes();
    assert(!(await tid('first-hint').count()), '첫 획 뒤 안내 사라짐');
    await writeText(`온도 600℃, 2시간 유지. 오프라인 작성. ${SECRET}`);
    await saveVersion(/기기에 저장했습니다/);
    await until(async () => (await pendingCount()) === 1, '올릴 버전 1');
    await shot('02-offline-written');
  });

  await check('기기 저장소는 암호화되어 있다(글상자 평문 없음)', async () => {
    const dump = await page.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('Disc');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const all = req.result.transaction(['FileStorage'], 'readonly').objectStore('FileStorage').getAll();
        all.onsuccess = () => resolve(all.result.map((r) => ({ path: r.path, content: typeof r.content === 'string' ? r.content : '' })));
      };
    }));
    const files = dump.filter((f) => f.path.includes('goono-note/'));
    assert(files.some((f) => f.path.includes('/working/')) && files.some((f) => f.path.includes('/images/')), '작업본·페이지 이미지 파일 존재');
    const joined = files.map((f) => f.content).join('\n');
    assert(!joined.includes(SECRET) && !joined.includes('온도') && !joined.includes('strokes'), '평문이 저장소에 없다');
  });

  await check('오프라인 상태로 앱 재시작 → 필기·글상자 복원', async () => {
    await page.reload();
    await tid('note-list').waitFor();
    const card = page.locator('[data-testid="note-card"]', { hasText: A });
    await until(async () => /올릴 버전 1/.test(await card.textContent()), '목록에 올릴 버전 1');
    assert(await card.locator('.thumb img').count() === 1, '목록 썸네일');
    await card.click();
    await tid('palette').waitFor();
    assert((await readText()).includes(SECRET), '글상자 내용 복원');
  });

  await check('구노 웹: 태블릿에서 작성 중인 노트는 점검 요청 거부', async () => {
    const n = await noteByTitle(A);
    const r = await admin(`/notes/${n.noteMno}/status`, { status: 'INSPECTION' });
    assert(r.status === 409 && r.body.error.code === 'EDITING_ON_DEVICE', `409 EDITING_ON_DEVICE (${r.status})`);
  });

  await check('온라인 복귀 → 자동 동기화, 웹과 같은 손글씨 블록(페이지 PNG + 획 JSON + 레이아웃)', async () => {
    await setOffline(false);
    await waitAllSent();
    const st = await serverState();
    const n = st.notes.find((x) => x.title === A);
    assert(n.versionIds.length === 1, `서버 버전 1개 (${n.versionIds.length})`);
    const v = st.versions.find((x) => x.versionId === n.versionIds[0]);
    assert(v.hasDrawing && v.inlineImagePaths === 1 && v.source === 'APP', `손글씨 블록 + 페이지 이미지 1장 (${v.inlineImagePaths})`);
    const html = await (await fetch(`${MOCK}/versions/${v.versionId}`)).text();
    const fig = /<figure class="rw-drawing"[^>]*data-strokes="([^"]+)"[^>]*data-drawing-sha256="([0-9a-f]{64})"/.exec(html);
    assert(fig, 'figure.rw-drawing[data-strokes][data-drawing-sha256]');
    const doc = JSON.parse(fig[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    assert(doc.layout?.type === 'pages' && doc.strokes.some((s) => s.tool === 'text' && s.text.includes(SECRET)), '획 JSON에 페이지 레이아웃·글상자');
    assert(/alt="손글씨 1\/1쪽"/.test(html), '한글 대체 텍스트');
    const imgPath = /src="(\/editor-inline-images\/[^"]+)"/.exec(html)[1];
    const img = await fetch(MOCK + imgPath.replace(/&amp;/g, '&'));
    const bytes = new Uint8Array(await img.arrayBuffer());
    assert(img.status === 200 && bytes[0] === 0x89 && bytes[1] === 0x50, '페이지 이미지 PNG');
    // A4 본문 비율 (267/180) 페이지 한 장
    const w = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
    const h = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
    assert(Math.abs(h / w - 267 / 180) < 0.01, `페이지 비율 A4 본문 (${w}×${h})`);
  });

  await check('제목 고치기 + 두 번째 페이지 필기 → 버전과 함께 서버 제목 변경', async () => {
    await page.locator('.title-btn').click();
    await tid('title-input').fill(A2);
    await page.keyboard.press('Enter');
    await until(async () => (await tid('note-title').textContent()) === A2, '제목 변경');
    // 두 번째 페이지로 넘겨 쓰기 (손가락 넘기기 대신 휠)
    const b = await tid('board').boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    // 문서 끝(= 빈 2쪽의 아래쪽)까지 내린다
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 1200); await page.waitForTimeout(100); }
    await page.waitForTimeout(300);
    await drawStrokes(0);
    await saveVersion(/구노에 올렸습니다/);
    const n = await until(() => noteByTitle(A2), '서버 제목 변경');
    assert(n.versionIds.length === 2, '서버 버전 2개');
    const v = (await serverState()).versions.find((x) => x.versionId === n.versionIds[1]);
    assert(v.inlineImagePaths === 2, `페이지 2장 (${v.inlineImagePaths})`);
  });

  await check('작성 완료 → 편집권 반납(웹), 앱은 읽기 전용(도구 사라짐), 웹에서 점검 요청 가능', async () => {
    await tid('release').click();
    await tid('release-confirm').click();
    await toast(/구노 웹으로 넘겼습니다/);
    const n = await noteByTitle(A2);
    assert(n.editLocation.type === 'WEB', '서버 편집 위치 WEB');
    await until(async () => (await blockOf()) === 'RELEASED', '반납 배너');
    assert(!(await paletteVisible()), '필기 도구 숨김');
    assert(await tid('release').isDisabled(), '작성 완료 비활성');
    const r = await admin(`/notes/${n.noteMno}/status`, { status: 'INSPECTION' });
    assert(r.status === 200, '웹 점검 요청 허용');
    await tid('status-pill').click();
    await tid('sync-now').click();
    await tid('status-pill').click();
    await tid('back').click();
    await until(async () => /점검 중/.test(await page.locator('[data-testid="note-card"]', { hasText: A2 }).textContent()), '목록에 점검 중');
    await shot('03-released');
  });

  await check('편집권 회수: 회수 뒤 버전은 미반영으로 보관', async () => {
    await newNote(B);
    await writeText('배지 교체, 세포 밀도 80%.', 20);
    await saveVersion(/구노에 올렸습니다/);
    await setOffline(true);
    await writeText('오후 관찰: 오염 없음 (회수 후 작성).', 120);
    await saveVersion(/기기에 저장했습니다/);
    const n = await noteByTitle(B);
    await admin(`/notes/${n.noteMno}/reclaim`, { reason: '기기 분실 신고' });
    await setOffline(false);
    await until(async () => (await blockOf()) === 'RECLAIMED', '회수 배너', 20_000);
    assert(!(await paletteVisible()), '필기 도구 숨김');
    assert((await noteByTitle(B)).versionIds.length === 1, '서버에는 회수 전 버전만');
    await tid('open-versions').click();
    await until(async () => (await page.locator('[data-testid="version-item"][data-state="REJECTED"]').count()) === 1, '미반영 1');
    assert(await page.locator('[data-testid="version-item"][data-state="SENT"]').count() === 1, '올라간 1');
    await shot('04-reclaimed-versions');
  });

  await check('미반영 버전 → 새 노트로 복원 → 서버에 올림', async () => {
    await page.locator('[data-testid="version-item"][data-state="REJECTED"] [data-testid="version-restore"]').click();
    await tid('new-note-create').click();
    await tid('palette').waitFor();
    assert((await readText(120)).includes('회수 후 작성'), '복원 내용');
    await saveVersion(/구노에 올렸습니다/);
    const n = await until(() => noteByTitle(`${B} (복원)`), '복원 노트 서버 생성');
    assert(n.versionIds.length === 1 && n.editLocation.type === 'DEVICE', '복원 노트 버전 1, 편집 위치 이 기기');
  });

  await check('오프라인 작성 기한 만료 → 편집 잠금, 기록은 보존', async () => {
    await admin('/config', { tokenTtlMs: 8000 });
    await tid('back').click();
    await tid('sync-now').click();
    await until(async () => /시간 남음/.test(await tid('deadline').textContent()), '짧은 기한 받음');
    await setOffline(true);
    await newNote(C);
    await drawStrokes();
    await tid('back').click();
    await until(async () => (await lockOf()) === 'OFFLINE_EXPIRED', '기한 만료 잠금', 30_000);
    assert(await tid('new-note').first().isDisabled(), '새 노트 비활성');
    await page.locator('[data-testid="note-card"]', { hasText: C }).click();
    await tid('board').waitFor();
    await page.waitForTimeout(400);
    assert(!(await paletteVisible()), '필기 도구 숨김(읽기 전용)');
    await shot('05-offline-expired');
  });

  await check('만료 후 연결 → 재로그인 요구 → 재로그인하면 대기 버전 업로드', async () => {
    await admin('/config', { tokenTtlMs: null });
    await setOffline(false);
    await until(async () => (await lockOf()) === 'NEEDS_LOGIN', '재로그인 요구', 20_000);
    await page.getByRole('button', { name: '다시 로그인' }).click();
    assert(await tid('login-id').isDisabled(), '아이디 고정');
    await tid('login-pw').fill('goono1234');
    await tid('login-submit').click();
    await tid('palette').waitFor();
    await waitAllSent();
    const n = await until(() => noteByTitle(C), '오프라인 노트 서버 생성');
    assert(n.versionIds.length === 1, '오프라인 노트 버전 업로드');
    assert((await tid('lock-banner').count()) === 0, '잠금 해제');
  });

  await check('기기 사용 중지(폐기) → 잠금', async () => {
    const st = await serverState();
    await admin(`/devices/${st.devices[0].deviceId}/revoke`, {});
    await tid('status-pill').click();
    await tid('sync-now').click();
    await until(async () => (await lockOf()) === 'REVOKED', '폐기 잠금');
    assert(!(await paletteVisible()), '필기 도구 숨김');
    await shot('06-revoked');
  });

  // 서버 응답(409·401)·오프라인 요청 실패는 시나리오상 예상되는 리소스 오류 — 스크립트 예외만 본다
  const benign = consoleErrors.filter((e) => !/^Failed to load resource:/.test(e));
  await check('페이지 오류 없음', async () => { assert(!benign.length, benign.join('\n')); });
} catch {
  // 실패 단계는 위에서 기록
} finally {
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ results, consoleErrors }, null, 2));
  await browser.close();
  mock.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} 통과${failed ? ' — 실패 있음' : ''} (스크린숏: tests/e2e/out)`);
  process.exit(failed ? 1 : 0);
}
