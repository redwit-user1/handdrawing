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
const editor = () => page.locator('.editor-host .ProseMirror').first();
const setOffline = async (v) => {
  await context.setOffline(v);
  await until(async () => (await tid('net-state').textContent()) === (v ? '오프라인' : '온라인'), `네트워크 표시 ${v ? '오프라인' : '온라인'}`);
};
const waitAllSent = () => until(async () => (await tid('pending-count').textContent()) === '모두 올림', '올릴 기록 없음', 20_000);
const noteByTitle = async (title) => (await serverState()).notes.find((n) => n.title === title);
const toast = async (re) => {
  let seen = '';
  return until(async () => { const t = await tid('toast').textContent({ timeout: 500 }).catch(() => ''); if (t) seen = t; return re.test(t) && t; }, `알림 ${re}`)
    .catch((e) => { throw new Error(`${e.message} — 마지막 알림: "${seen}"`); });
};

async function createNote(title) {
  await tid('new-note').click();
  await tid('new-note-title').fill(title);
  await tid('new-note-create').click();
  await editor().waitFor({ timeout: 20_000 });
}
async function typeInEditor(text) {
  await editor().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
  await until(async () => /기기에 저장됨/.test(await tid('saved-state').textContent()), '작업본 저장');
}
async function drawInModal() {
  await page.locator('button[title^="손글씨"]').first().click();
  const frameEl = await page.locator('iframe').first().elementHandle();
  const frame = await frameEl.contentFrame();
  await frame.locator('#board').waitFor();
  await until(async () => page.getByRole('button', { name: '본문에 삽입' }).isEnabled(), '손글씨 편집기 준비');
  const box = await frame.locator('#board').boundingBox();
  // "Hi" 비슷한 획 세 개 (펜 대신 마우스 포인터)
  const strokes = [
    [[0.2, 0.2], [0.2, 0.45]],
    [[0.2, 0.32], [0.3, 0.32]],
    [[0.3, 0.2], [0.3, 0.45]],
    [[0.38, 0.28], [0.38, 0.45]],
  ];
  for (const s of strokes) {
    await page.mouse.move(box.x + box.width * s[0][0], box.y + box.height * s[0][1]);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      const t = i / 12;
      await page.mouse.move(box.x + box.width * (s[0][0] + (s[1][0] - s[0][0]) * t), box.y + box.height * (s[0][1] + (s[1][1] - s[0][1]) * t));
    }
    await page.mouse.up();
  }
  await page.getByRole('button', { name: '본문에 삽입' }).click();
  await until(async () => (await page.locator('.editor-host figure.rw-drawing img').count()) > 0, '손글씨 삽입');
  await until(async () => /기기에 저장됨/.test(await tid('saved-state').textContent()), '작업본 저장');
}

const A = '시료 A 600℃ 열처리';
const B = '세포 배양 2일차';
const C = '오프라인에서 만든 노트';
const SECRET = '비밀실험값-7Q3Z';

try {
  console.log(`E2E (앱 ${APP}, 모의 서버 ${MOCK})`);

  await check('로그인(기기 등록)', async () => {
    await page.goto(APP);
    await tid('login-server').fill(MOCK);
    await tid('login-id').fill('researcher1');
    await tid('login-pw').fill('goono1234');
    await tid('login-device').fill('연구실 iPad (E2E)');
    await tid('login-submit').click();
    await tid('new-note').waitFor();
    await until(async () => /일 남음/.test(await tid('deadline').textContent()), '오프라인 작성 기한 표시');
    const st = await serverState();
    assert(st.devices.length === 1 && st.devices[0].name === '연구실 iPad (E2E)', '서버에 기기 등록');
  });

  await check('새 노트(온라인) → 서버에 노트 생성, 편집 위치 = 이 기기', async () => {
    await createNote(A);
    const n = await until(() => noteByTitle(A), '서버 노트 생성');
    assert(n.editLocation.type === 'DEVICE', '편집 위치 DEVICE');
    await shot('01-new-note');
  });

  await check('오프라인에서 글 + 손글씨 작성 → 버전 저장(기기 대기)', async () => {
    await setOffline(true);
    await typeInEditor(`온도 600℃, 2시간 유지. 오프라인 작성. ${SECRET}`);
    await drawInModal();
    await tid('save-version').click();
    await toast(/기기에 저장했습니다/);
    await until(async () => (await tid('pending-count').textContent()) === '올릴 기록 1건', '올릴 기록 1건');
    await shot('02-offline-written');
  });

  await check('기기 저장소는 암호화되어 있다(본문 평문 없음)', async () => {
    const dump = await page.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('Disc');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction(['FileStorage'], 'readonly');
        const all = tx.objectStore('FileStorage').getAll();
        all.onsuccess = () => resolve(all.result.map((r) => ({ path: r.path, content: typeof r.content === 'string' ? r.content : '' })));
      };
    }));
    const files = dump.filter((f) => f.path.includes('goono-note/'));
    assert(files.some((f) => f.path.includes('/working/')) && files.some((f) => f.path.includes('/images/')), '작업본·이미지 파일 존재');
    const joined = files.map((f) => f.content).join('\n');
    assert(!joined.includes(SECRET) && !joined.includes('온도'), '평문이 저장소에 없다');
    assert(!joined.includes(Buffer.from(SECRET).toString('base64').slice(0, 12)), 'base64 평문도 없다');
  });

  await check('오프라인 상태로 앱 재시작 → 노트·작업본·이미지 복원', async () => {
    await page.reload();
    await tid('note-list').waitFor();
    const card = page.locator('[data-testid="note-card"]', { hasText: A });
    await until(async () => /올릴 기록 1/.test(await card.textContent()), '목록에 올릴 기록 1');
    await card.click();
    await editor().waitFor();
    await until(async () => (await editor().textContent()).includes(SECRET), '본문 복원');
    const src = await page.locator('.editor-host figure.rw-drawing img').first().getAttribute('src');
    assert(src.startsWith('blob:'), `손글씨 이미지 복호화 표시 (${src.slice(0, 20)})`);
    const loaded = await page.locator('.editor-host figure.rw-drawing img').first().evaluate((img) => img.complete && img.naturalWidth > 0);
    assert(loaded, '손글씨 이미지가 실제로 그려짐');
  });

  await check('구노 웹: 태블릿에서 작성 중인 노트는 점검 요청 거부', async () => {
    const n = await noteByTitle(A);
    const r = await admin(`/notes/${n.noteMno}/status`, { status: 'INSPECTION' });
    assert(r.status === 409 && r.body.error.code === 'EDITING_ON_DEVICE', `409 EDITING_ON_DEVICE (${r.status})`);
  });

  await check('온라인 복귀 → 자동 동기화, 서버에 버전·손글씨 이미지 반영', async () => {
    await setOffline(false);
    await waitAllSent();
    const st = await serverState();
    const n = st.notes.find((x) => x.title === A);
    assert(n.versionIds.length === 1, `서버 버전 1개 (${n.versionIds.length})`);
    const v = st.versions.find((x) => x.versionId === n.versionIds[0]);
    assert(v.hasDrawing && v.inlineImagePaths >= 1 && v.source === 'APP', '손글씨 figure + 인라인 이미지 경로');
    const html = await (await fetch(`${MOCK}/versions/${v.versionId}`)).text();
    assert(html.includes(SECRET), '본문 반영');
    const imgPath = /src="(\/editor-inline-images\/[^"]+)"/.exec(html)[1];
    const img = await fetch(MOCK + imgPath.replace(/&amp;/g, '&'));
    const bytes = new Uint8Array(await img.arrayBuffer());
    assert(img.status === 200 && bytes[0] === 0x89 && bytes[1] === 0x50, '이미지 파일 PNG');
  });

  await check('온라인에서 추가 작성 → 버전 저장 즉시 업로드', async () => {
    await typeInEditor(' 냉각 후 XRD 측정 예정.');
    await tid('save-version').click();
    await toast(/구노에 올렸습니다/);
    const n = await noteByTitle(A);
    assert(n.versionIds.length === 2, '서버 버전 2개');
  });

  await check('작성 완료 → 편집권 반납(웹), 앱은 읽기 전용, 웹에서 점검 요청 가능', async () => {
    await tid('release').click();
    await tid('release-confirm').click();
    await toast(/구노 웹으로 넘겼습니다/);
    const n = await noteByTitle(A);
    assert(n.editLocation.type === 'WEB', '서버 편집 위치 WEB');
    await until(async () => (await tid('block-banner').getAttribute('data-kind')) === 'RELEASED', '반납 배너');
    assert((await editor().getAttribute('contenteditable')) === 'false', '편집기 읽기 전용');
    assert(await tid('save-version').isDisabled(), '버전 저장 비활성');
    const r = await admin(`/notes/${n.noteMno}/status`, { status: 'INSPECTION' });
    assert(r.status === 200, '웹 점검 요청 허용');
    await tid('sync-now').click();
    await until(async () => /점검 중/.test(await page.locator('.title-block').textContent()), '앱에 점검 중 표시');
    await shot('03-released');
  });

  await check('편집권 회수: 회수 뒤 올린 버전은 미반영 기록으로 보관', async () => {
    await tid('back').click();
    await createNote(B);
    await typeInEditor('배지 교체, 세포 밀도 80%.');
    await tid('save-version').click();
    await toast(/구노에 올렸습니다/);
    await setOffline(true);
    await typeInEditor(' 오후 관찰: 오염 없음 (회수 후 작성).');
    await tid('save-version').click();
    await toast(/기기에 저장했습니다/);
    const n = await noteByTitle(B);
    await admin(`/notes/${n.noteMno}/reclaim`, { reason: '기기 분실 신고' });
    await setOffline(false);
    await until(async () => (await tid('block-banner').getAttribute('data-kind').catch(() => '')) === 'RECLAIMED', '회수 배너');
    assert((await noteByTitle(B)).versionIds.length === 1, '서버에는 회수 전 버전만');
    await tid('open-versions').click();
    await until(async () => (await page.locator('[data-testid="version-item"][data-state="REJECTED"]').count()) === 1, '미반영 1건');
    assert(await page.locator('[data-testid="version-item"][data-state="SENT"]').count() === 1, '올라간 1건');
    await shot('04-reclaimed-versions');
  });

  await check('미반영 기록 → 새 노트로 복원 → 서버에 올림', async () => {
    await page.locator('[data-testid="version-item"][data-state="REJECTED"] [data-testid="version-restore"]').click();
    await tid('new-note-create').click();
    await editor().waitFor();
    await until(async () => (await editor().textContent()).includes('회수 후 작성'), '복원 본문');
    await tid('save-version').click();
    await toast(/구노에 올렸습니다/);
    const n = await until(() => noteByTitle(`${B} (복원)`), '복원 노트 서버 생성');
    assert(n.versionIds.length === 1 && n.editLocation.type === 'DEVICE', '복원 노트 버전 1, 편집 위치 이 기기');
  });

  await check('오프라인 작성 기한 만료 → 편집 잠금, 기록은 보존', async () => {
    await admin('/config', { tokenTtlMs: 8000 });
    await tid('sync-now').click();
    await until(async () => /시간 남음/.test(await tid('deadline').textContent()), '짧은 기한 받음');
    await setOffline(true);
    await tid('back').click();
    await createNote(C);
    await typeInEditor('기한 만료 직전에 오프라인으로 만든 노트.');
    await tid('save-version').click();
    await toast(/기기에 저장했습니다/);
    await tid('back').click();
    await until(async () => (await tid('lock-banner').getAttribute('data-lock').catch(() => '')) === 'OFFLINE_EXPIRED', '기한 만료 잠금', 30_000);
    assert(await tid('new-note').isDisabled(), '새 노트 비활성');
    await page.locator('[data-testid="note-card"]', { hasText: C }).click();
    await editor().waitFor();
    assert((await editor().getAttribute('contenteditable')) === 'false', '편집기 읽기 전용');
    assert((await editor().textContent()).includes('기한 만료 직전'), '작성분 보존');
    await shot('05-offline-expired');
  });

  await check('만료 후 연결 → 재로그인 요구 → 재로그인하면 대기 기록 업로드', async () => {
    await admin('/config', { tokenTtlMs: null });
    await setOffline(false);
    await until(async () => (await tid('lock-banner').getAttribute('data-lock').catch(() => '')) === 'NEEDS_LOGIN', '재로그인 요구', 20_000);
    await page.getByRole('button', { name: '다시 로그인' }).click();
    assert(await tid('login-id').isDisabled(), '아이디 고정');
    await tid('login-pw').fill('goono1234');
    await tid('login-submit').click();
    await editor().waitFor();
    await waitAllSent();
    const n = await until(() => noteByTitle(C), '오프라인 노트 서버 생성');
    assert(n.versionIds.length === 1, '오프라인 노트 버전 업로드');
    assert((await tid('lock-banner').count()) === 0, '잠금 해제');
    assert((await editor().getAttribute('contenteditable')) === 'true', '다시 편집 가능');
  });

  await check('기기 사용 중지(폐기) → 잠금', async () => {
    const st = await serverState();
    await admin(`/devices/${st.devices[0].deviceId}/revoke`, {});
    await tid('sync-now').click();
    await until(async () => (await tid('lock-banner').getAttribute('data-lock').catch(() => '')) === 'REVOKED', '폐기 잠금');
    assert((await editor().getAttribute('contenteditable')) === 'false', '편집기 읽기 전용');
    await shot('06-revoked');
  });

  // 409·401 등 서버 응답과 오프라인 요청 실패, 닫은 노트의 blob 이미지는 시나리오상 예상되는 리소스 오류 — 스크립트 예외만 본다
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
