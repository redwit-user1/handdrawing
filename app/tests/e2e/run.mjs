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

/** 구노 웹의 "QR 띄우기" 대신 — 모의 서버가 연결 코드(XXXX-XXXX)·QR 내용을 발급 */
const issueCode = async (loginId, ttlMs) => (await admin('/pairing-code', ttlMs ? { loginId, ttlMs } : { loginId })).body;
const codeState = async (code) => (await serverState()).pairingCodes.find((c) => c.code === code.replace('-', '')); // 서버는 하이픈 없이 저장
/** 연결 화면 "코드 직접 입력"에 넣고 연결 → { ok, error } */
async function submitCode(text, { request = true } = {}) {
  await tid('connect-code').fill(text);
  const res = request ? page.waitForResponse((r) => r.url().endsWith('/devices/pair') && r.request().method() === 'POST') : null;
  await tid('connect-submit').click();
  if (res) await res;
  return until(async () => {
    // 화면이 바뀌는 중에도 한 번에 읽는다
    const st = await page.evaluate(() => {
      const f = document.querySelector('[data-testid="connect-form"]');
      if (!f) return { gone: true };
      return { busy: f.querySelector('[data-testid="connect-submit"]').disabled, error: f.querySelector('[data-testid="connect-error"]')?.textContent ?? '' };
    });
    if (st.gone) return { ok: true, error: '' }; // 연결되어 화면이 바뀜
    return !st.busy && st.error ? { ok: false, error: st.error } : null;
  }, '연결 결과');
}
const INVALID_MSG = '코드가 맞지 않거나 만료되었습니다. 구노 웹에서 새 QR을 띄워 주세요.';

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
// 네이티브에서 App 플러그인이 보내는 appUrlOpen(딥링크)을 웹에서 흉내 낸다
const openLink = (url) => page.evaluate(async (u) => { await window.Capacitor.Plugins.App.notifyListeners('appUrlOpen', { url: u }); }, url);
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

  await check('딥링크 goono-note://pair: 우리 링크가 아니면 무시, 맞으면 확인 단계(연결 요청 없음), https 아닌 서버는 원인 안내', async () => {
    await page.goto(APP);
    await tid('connect').waitFor();
    await openLink('https://example.org/pair?server=https%3A%2F%2Fx.example.org&code=K7Q2-M9XD');
    await openLink('goono-note://other?server=https%3A%2F%2Fx.example.org&code=K7Q2-M9XD');
    await page.waitForTimeout(300);
    assert(!(await tid('connect-confirm').count()), '우리 링크가 아니면 화면이 바뀌지 않음');
    await openLink('goono-note://pair?server=https%3A%2F%2Feln.example.org&code=k7q2-m9xd');
    await tid('connect-confirm').waitFor();
    assert((await tid('connect-confirm-host').textContent()) === 'eln.example.org', '확인 단계에 서버 호스트 표시');
    assert(/K7Q2-M9XD/.test(await page.locator('[data-testid="connect-confirm"]').textContent()), '코드는 정규화해 표시');
    await tid('connect-confirm').getByText('취소').click();
    await tid('connect').waitFor();
    assert((await serverState()).devices.length === 0, '확인만 하고 취소 — 서버에 기기 등록 없음');
    // 운영 빌드는 https 가 아닌 서버 링크를 연결 시도 없이 거부하고 원인을 알린다
    await openLink('goono-note://pair?server=http%3A%2F%2F192.168.0.5%3A8080&code=K7Q2-M9XD');
    await tid('connect-error').waitFor();
    assert(/https가 아닙니다/.test(await tid('connect-error').textContent()) && !(await tid('connect-confirm').count()), 'http 서버 링크 거부');
  });

  await check('연결 화면: 잘못된 코드·http QR은 요청 없이 거부, 기관 사용 안 함·시도 제한 안내', async () => {
    await page.goto(APP);
    await tid('connect').waitFor();
    assert((await page.locator('[data-testid="connect"] h1').textContent()) === 'QR로 연결', '첫 화면 제목');
    assert((await tid('connect-scan').count()) === 0, '웹에서는 QR 읽기 버튼 없음');
    assert((await tid('connect-password').count()) === 0 && (await tid('connect-demo').count()) === 0, '운영 빌드에는 비밀번호·체험 링크 없음');
    await shot('00-connect');
    await tid('connect-manual').click();
    await tid('connect-server').fill(MOCK);
    await tid('connect-device').fill('연구실 iPad (E2E)');
    // 8자가 아닌 코드 — 요청하지 않는다
    let r = await submitCode('ABC', { request: false });
    assert(/8자/.test(r.error), `코드 형식 안내 (${r.error})`);
    // QR 내용을 붙여 넣었는데 서버가 http — 운영 빌드는 연결을 시도하지 않고 원인을 알린다
    const issued = await issueCode('researcher1');
    assert(/^goono-note:\/\/pair\?server=http/.test(issued.qrPayload), 'QR 내용');
    r = await submitCode(issued.qrPayload, { request: false });
    assert(/https가 아닙니다/.test(r.error) && !(await tid('connect-confirm').count()), `http 서버 QR 거부 (${r.error})`);
    assert(!(await codeState(issued.code)).usedAt, '코드는 쓰이지 않음');
    // 기관이 태블릿 연결을 끔
    await admin('/config', { appEnabled: false });
    r = await submitCode(issued.code);
    assert(r.error === '이 기관은 태블릿 연결을 사용하지 않습니다. 관리자에게 문의하세요.', `APP_DISABLED 문구 (${r.error})`);
    await admin('/config', { appEnabled: true });
    // 틀린 코드 5번 → 6번째는 시도 제한(남은 시간 안내)
    const wrong = issued.code === 'ZZZZ-ZZZZ' ? 'YYYY-YYYY' : 'ZZZZ-ZZZZ';
    for (let i = 0; i < 5; i++) {
      r = await submitCode(wrong);
      assert(r.error === INVALID_MSG, `INVALID 문구 ${i + 1} (${r.error})`);
    }
    r = await submitCode(issued.code);
    assert(/^시도가 너무 많습니다\. 잠시 후 다시 시도하세요\. \(약 \d+초 후\)$/.test(r.error), `TOO_MANY_ATTEMPTS 문구 (${r.error})`);
    await shot('00-connect-error');
    await admin('/reset', {});
  });

  let firstCode;
  await check('코드 직접 입력(소문자·하이픈 없이·앞뒤 공백)으로 연결(기기 등록)', async () => {
    firstCode = (await issueCode('researcher1')).code;
    const r = await submitCode(`  ${firstCode.replace('-', '').toLowerCase()} `);
    assert(r.ok, `연결 (${r.error})`);
    await tid('new-note').first().waitFor();
    await until(async () => /일 남음/.test(await tid('deadline').textContent()), '오프라인 작성 기한 표시');
    const st = await serverState();
    assert(st.devices.length === 1 && st.devices[0].name === '연구실 iPad (E2E)' && st.devices[0].userMno === 12, '서버에 기기 등록(researcher1)');
    assert((await codeState(firstCode)).usedAt, '코드 사용됨(일회용)');
    // 이미 연결된 채 평소 화면이면 딥링크는 무시
    await openLink('goono-note://pair?server=https%3A%2F%2Feln.example.org&code=K7Q2-M9XD');
    await page.waitForTimeout(300);
    assert(!(await tid('connect').count()) && !(await tid('connect-confirm').count()) && (await tid('new-note').count()) > 0, '연결된 상태의 딥링크는 무시');
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

  await check('이어 쓰는 동안은 저장하지 않고, 손을 멈추면 한 번 저장', async () => {
    await tid('tool-pen').click();
    // 저장 표시가 바뀌는 순간을 모두 기록
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="saved-state"]');
      window.__saveLog = [];
      new MutationObserver(() => window.__saveLog.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    });
    // 획 사이 0.7초, 9초 가까이 쉬지 않고 쓴다 (예전에는 획마다 저장했다)
    const t0 = Date.now();
    for (let k = 0; k < 12; k++) {
      const a = await pagePoint(k * 14, 420), b = await pagePoint(k * 14 + 10, 470);
      await page.mouse.move(a[0], a[1]);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) { await page.mouse.move(a[0] + (b[0] - a[0]) * i / 8, a[1] + (b[1] - a[1]) * i / 8); await page.waitForTimeout(20); }
      await page.mouse.up();
      await page.waitForTimeout(550);
    }
    const writing = Date.now() - t0;
    const during = await page.evaluate(() => window.__saveLog.slice());
    assert(writing > 6000, `충분히 오래 썼다 (${writing}ms)`);
    assert(!during.some((t) => /저장 중|기기에 저장됨/.test(t)), `쓰는 동안 저장 없음: ${during.join(' | ')}`);
    assert(/쓰는 중/.test(await tid('saved-state').textContent()), '쓰는 중 표시');
    await waitSaved();
    const saves = await page.evaluate(() => window.__saveLog.filter((t) => /저장 중/.test(t)).length);
    assert(saves === 1, `멈춘 뒤 한 번 저장 (${saves})`);
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

  await check('+ 넣기: 표(칸 글) → 수식 → 화학식 → 날짜 도장 → 구조식(SMILES)', async () => {
    const ins = async (kind) => { await tid('tool-insert').click(); await tid(`insert-${kind}`).click(); };
    // 표 3×3 → 4줄, 머리글·칸 글
    await ins('table');
    await tid('table-dialog').waitFor();
    await tid('table-rows-plus').click();
    const cells = page.locator('[data-testid="table-grid"] input');
    assert(await cells.count() === 12, `4×3 칸 (${await cells.count()})`);
    await cells.nth(0).fill('시료'); await cells.nth(1).fill('온도(℃)'); await cells.nth(2).fill('XRD 피크');
    await cells.nth(3).fill('A-1'); await cells.nth(4).fill('600');
    await tid('table-submit').click();
    await until(async () => /표 고치기/.test(await tid('edit-object').textContent().catch(() => '')), '표 선택·고치기 버튼');
    // 수식 (LaTeX 직접)
    await ins('math');
    await tid('formula-dialog').waitFor();
    await page.locator('.tex-source summary').click();
    await tid('tex-source').fill('x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}');
    await until(async () => (await tid('formula-preview').locator('img').count()) === 1, '수식 미리보기');
    await tid('formula-submit').click();
    await until(async () => /수식 고치기/.test(await tid('edit-object').textContent().catch(() => '')), '수식 선택');
    // 화학식 (mhchem) — 문법 오류는 알려 주고 넣기 비활성
    await ins('ce');
    await tid('ce-input').fill('2H2 + O2 -> 2H2O{');
    await until(async () => /고칠 곳/.test(await tid('formula-preview').textContent()), '화학식 오류 안내');
    assert(await tid('formula-submit').isDisabled(), '오류면 넣기 비활성');
    await tid('ce-input').fill('2H2 + O2 -> 2H2O');
    await until(async () => (await tid('formula-preview').locator('img').count()) === 1, '화학식 미리보기');
    await tid('formula-submit').click();
    // 날짜·시각 도장
    await ins('stamp');
    await until(async () => /글상자 고치기/.test(await tid('edit-object').textContent().catch(() => '')), '도장 글상자 선택');
    // 구조식 (Ketcher, 기기 안 WASM) — SMILES 로 불러와 넣기
    await ins('chem');
    await tid('structure-sheet').waitFor({ timeout: 60_000 });
    await tid('smiles-input').fill('CC(=O)Oc1ccccc1C(=O)O');
    await until(async () => !(await tid('smiles-load').isDisabled()), '구조식 편집기 준비', 90_000);
    await tid('smiles-load').click();
    await page.waitForTimeout(1500);
    await tid('structure-submit').click();
    await until(async () => (await tid('structure-sheet').count()) === 0, '구조식 넣기', 30_000);
    await until(async () => /구조식 고치기/.test(await tid('edit-object').textContent().catch(() => '')), '구조식 선택');
    await waitSaved();
    await shot('07-inserted-objects');
  });

  await check('넣은 객체 다시 고치기: 올가미로 표를 눌러 선택 → 칸 글 수정 → 실행 취소·다시 실행', async () => {
    // 표를 찾아 누르기 — 엔진 객체 위치를 화면 좌표로
    await tid('tool-lasso').click();
    await page.mouse.click(5, 400); // 빈 곳 (선택 해제) — 팔레트 밖 캔버스 왼쪽 여백
    const box = await tid('board').boundingBox();
    const tableAt = await page.evaluate(() => {
      const e = window.__engine;
      const t = e.strokes.find((s) => s.tool === 'table');
      const [[x0, y0], [x1, y1]] = t.points;
      return { x: ((x0 + x1) / 2) * e.scale + e.tx, y: ((y0 + y1) / 2) * e.scale + e.ty };
    });
    await page.mouse.click(box.x + tableAt.x, box.y + tableAt.y);
    await until(async () => /표 고치기/.test(await tid('edit-object').textContent().catch(() => '')), '누르면 표 선택');
    await tid('edit-object').click();
    const cells = page.locator('[data-testid="table-grid"] input');
    assert((await cells.nth(0).inputValue()) === '시료', '기존 칸 글');
    await cells.nth(5).fill('2θ=28.4°');
    await tid('table-submit').click();
    const cellOf = () => page.evaluate(() => window.__engine.strokes.find((s) => s.tool === 'table').cells[1][2]);
    await until(async () => (await cellOf()) === '2θ=28.4°', '칸 글 수정');
    await tid('undo').click();
    assert((await cellOf()) === '', '실행 취소');
    await tid('redo').click();
    assert((await cellOf()) === '2θ=28.4°', '다시 실행');
    await waitSaved();
  });

  await check('버전에 객체 원본(표 칸·LaTeX·화학식·molfile)과 페이지 그림이 함께 올라간다', async () => {
    await saveVersion(/구노에 올렸습니다/);
    const n = await noteByTitle(A2);
    const vid = n.versionIds[n.versionIds.length - 1];
    const html = await (await fetch(`${MOCK}/versions/${vid}`)).text();
    const fig = /data-strokes="([^"]+)"/.exec(html);
    const docJson = JSON.parse(fig[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    const S = docJson.strokes;
    const table = S.find((x) => x.tool === 'table');
    assert(table && table.rows === 4 && table.cells[0][1] === '온도(℃)' && table.cells[1][2] === '2θ=28.4°', '표 칸 글');
    assert(S.some((x) => x.kind === 'math' && /\\frac/.test(x.latex) && /^data:image\/svg\+xml/.test(x.src)), '수식 LaTeX + SVG');
    assert(S.some((x) => x.kind === 'ce' && x.ce === '2H2 + O2 -> 2H2O'), '화학식 원문');
    assert(S.some((x) => x.kind === 'chem' && /M\s+END/.test(x.molfile) && x.smiles), '구조식 molfile·SMILES');
    assert(S.some((x) => x.tool === 'text' && /^\d{4}-\d{2}-\d{2} \([월화수목금토일]\) \d{2}:\d{2}$/.test(x.text)), '날짜 도장');
    const v = (await serverState()).versions.find((x) => x.versionId === vid);
    assert(v.inlineImagePaths >= 2, `페이지 그림 (${v.inlineImagePaths})`);
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

  await check('연결 만료 → "다시 연결"(서버 고정) → 이미 쓴 코드·만료된 코드는 안내만', async () => {
    await admin('/config', { tokenTtlMs: null });
    await setOffline(false);
    await until(async () => (await lockOf()) === 'NEEDS_LOGIN', '다시 연결 요구', 20_000);
    await tid('reconnect').click();
    await tid('connect').waitFor();
    assert(/김연구\(researcher1\)/.test(await tid('connect-account').textContent()), '연결된 계정 표시');
    await tid('connect-manual').click();
    assert(await tid('connect-server').isDisabled() && (await tid('connect-server').inputValue()) === MOCK, '서버 주소 고정');
    let r = await submitCode(firstCode);
    assert(r.error === INVALID_MSG, `같은 코드 재사용 거부 (${r.error})`);
    const expired = (await issueCode('researcher1', 1)).code;
    await new Promise((res) => setTimeout(res, 50));
    r = await submitCode(expired);
    assert(r.error === INVALID_MSG, `만료된 코드 거부 (${r.error})`);
    // 다시 연결 중 딥링크: 다른 서버의 QR 은 거부(지금 서버만), 엉뚱한 링크는 무시
    await openLink('goono-note://pair?server=https%3A%2F%2Fother.example.org&code=K7Q2-M9XD');
    await tid('connect-error').waitFor();
    const wrongMsg = await tid('connect-error').textContent();
    assert(/에 연결되어 있습니다/.test(wrongMsg) && !(await tid('connect-confirm').count()), `다른 서버 딥링크 거부 (${wrongMsg})`);
    await tid('connect-manual').click(); // 다음 단계가 이어서 코드를 넣는다
  });

  await check('다른 계정(researcher2) 코드로 다시 연결 → 올리지 않은 기록이 있어 거부, 기록은 남음', async () => {
    const other = (await issueCode('researcher2')).code;
    const r = await submitCode(other);
    assert(/김연구\(researcher1\) 님의 올리지 않은 기록이 있어 다른 계정으로 연결할 수 없습니다/.test(r.error) && /새 QR/.test(r.error), `거부 문구 (${r.error})`);
    assert(await tid('connect-form').isVisible(), '연결 화면에 머묾');
    assert(!(await noteByTitle(C)), '다른 계정으로 아무것도 올리지 않음');
    await shot('08-other-account-refused');
  });

  await check('새 코드(같은 계정)로 다시 연결 → 잠금 해제, 대기 버전 업로드(이어 쓰기)', async () => {
    const code = (await issueCode('researcher1')).code;
    const r = await submitCode(code);
    assert(r.ok, `연결 (${r.error})`);
    await tid('palette').waitFor();
    await waitAllSent();
    const n = await until(() => noteByTitle(C), '오프라인 노트 서버 생성');
    assert(n.versionIds.length === 1, '오프라인 노트 버전 업로드');
    assert((await tid('lock-banner').count()) === 0, '잠금 해제');
  });

  let versionsBeforeRevoke;
  await check('오프라인 대기 버전이 있는 채로 기기 사용 중지(폐기) → 잠금, 대기 버전은 기기에 남음', async () => {
    // 오프라인에서 더 쓰고 버전 저장 → 기기 대기 1
    await setOffline(true);
    await drawStrokes(200);
    await saveVersion(/기기에 저장했습니다/);
    await until(async () => (await pendingCount()) === 1, '올릴 버전 1');
    versionsBeforeRevoke = (await noteByTitle(C)).versionIds.length;
    // 그사이 구노에서 기기 사용 중지 → 연결되면 동기화가 거부되어 잠금
    const st = await serverState();
    await admin(`/devices/${st.devices[0].deviceId}/revoke`, {});
    await setOffline(false);
    await until(async () => (await lockOf()) === 'REVOKED', '폐기 잠금', 20_000);
    assert(!(await paletteVisible()), '필기 도구 숨김');
    assert((await pendingCount()) === 1, `대기 버전 유지 (${await pendingCount()})`);
    assert((await noteByTitle(C)).versionIds.length === versionsBeforeRevoke, '서버는 폐기 뒤 버전을 받지 않음');
    await shot('06-revoked');
  });

  await check('폐기 후 "다시 연결" → 새 코드 → 잠금 해제, 대기 버전 업로드·기기 기록 유지', async () => {
    await tid('reconnect').click();
    await tid('connect').waitFor();
    assert(/사용 중지/.test(await tid('connect').textContent()), '사용 중지 안내');
    await tid('connect-manual').click();
    const code = (await issueCode('researcher1')).code;
    const r = await submitCode(code.toLowerCase());
    assert(r.ok, `연결 (${r.error})`);
    await tid('palette').waitFor();
    assert((await tid('lock-banner').count()) === 0, '잠금 해제');
    // 폐기 전에 써 둔 대기 버전이 이어서 올라간다
    await waitAllSent();
    const n = await until(async () => { const x = await noteByTitle(C); return x.versionIds.length === versionsBeforeRevoke + 1 && x; }, '대기 버전 업로드');
    assert(n.editLocation.type === 'DEVICE', '편집 위치 이 기기 유지');
    await tid('back').click();
    await tid('note-list').waitFor();
    for (const t of [A2, B, `${B} (복원)`, C]) {
      assert(await page.locator('[data-testid="note-card"]', { hasText: t }).count(), `기기 노트 유지: ${t}`);
    }
    await tid('sync-now').click();
    await waitAllSent();
    const dev = (await serverState()).devices.find((d) => d.userMno === 12);
    assert(dev && !dev.revoked, '서버 기기 다시 사용');
    assert(!(await tid('sync-error').count()), '동기화 오류 없음');
    await shot('09-reconnected');
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
