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
    await tid('math-input').waitFor(); // 수식 입력기가 준비된 뒤에 LaTeX 칸을 쓴다 (입력기 자동 포커스와 겹치지 않게)
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
      e.revealObject(t); // 마지막에 넣은 구조식(다음 페이지)으로 화면이 따라갔다 — 표가 보이게
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
    assert(!(await tid('paper-picker').count()), '복원은 원래 종이 그대로 — 종이 고르기 없음');
    await tid('new-note-create').click();
    await tid('palette').waitFor();
    assert((await readText(120)).includes('회수 후 작성'), '복원 내용');
    await saveVersion(/구노에 올렸습니다/);
    const n = await until(() => noteByTitle(`${B} (복원)`), '복원 노트 서버 생성');
    assert(n.versionIds.length === 1 && n.editLocation.type === 'DEVICE', '복원 노트 버전 1, 편집 위치 이 기기');
  });

  await check('종이 템플릿: 새 노트에서 고르기 → 노트 안에서 바꾸기·실행 취소 → 다시 열어도 유지, 버전 레이아웃에 실림, 다음 노트 기본값', async () => {
    const P = '종이 템플릿 노트';
    const paperOf = () => page.evaluate(() => window.__engine.layout.paper ?? null);
    await tid('back').click();
    await tid('new-note').first().click();
    await tid('new-note-dialog').waitFor();
    assert(await tid('paper-option-grid').getAttribute('aria-checked') === 'true', '처음 기본값은 기본 모눈');
    assert(await page.locator('[data-testid^="paper-option-"]').count() === 7, '종이 7가지');
    await tid('new-note-title').fill(P);
    await tid('paper-option-lined').click();
    await tid('new-note-create').click();
    await tid('palette').waitFor();
    assert(await paperOf() === 'lined', `새 노트 종이 = 줄 노트 (${await paperOf()})`);
    await drawStrokes();
    // 노트 안에서 바꾸기 (노트 전체)
    await tid('paper-button').click();
    await tid('paper-pop').waitFor();
    assert(await tid('paper-option-lined').getAttribute('aria-checked') === 'true', '메뉴에 지금 종이 표시');
    await tid('paper-option-engineering').click();
    await until(async () => (await paperOf()) === 'engineering' && (await tid('paper-button').getAttribute('data-paper')) === 'engineering', '공학 모눈으로 바뀜');
    await shot('05-paper-picker');
    await tid('paper-button').click(); // 닫기
    assert(!(await tid('paper-pop').count()), '종이 메뉴 닫힘');
    // 종이 바꾸기도 편집 — 실행 취소·다시 실행
    await tid('undo').click();
    await until(async () => (await paperOf()) === 'lined', '실행 취소 → 줄 노트');
    await tid('redo').click();
    await until(async () => (await paperOf()) === 'engineering', '다시 실행 → 공학 모눈');
    await waitSaved();
    // 앱을 다시 열어도 유지
    await page.reload();
    await tid('note-list').waitFor();
    await page.locator('[data-testid="note-card"]', { hasText: P }).click();
    await tid('palette').waitFor();
    await until(async () => (await paperOf()) === 'engineering', '다시 열어도 공학 모눈');
    // 버전(웹 구노·서버 페이지 그림) 레이아웃에 실린다
    await saveVersion(/구노에 올렸습니다/);
    const n = await until(() => noteByTitle(P), '서버에 노트');
    const html = await (await fetch(`${MOCK}/versions/${n.versionIds[n.versionIds.length - 1]}`)).text();
    const fig = /data-strokes="([^"]+)"/.exec(html);
    const docJson = JSON.parse(fig[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    assert(docJson.layout.paper === 'engineering' && docJson.layout.type === 'pages', `data-strokes 레이아웃 paper (${docJson.layout.paper})`);
    // 다음 새 노트는 마지막으로 고른 종이로 시작
    await tid('back').click();
    await tid('new-note').first().click();
    await tid('new-note-dialog').waitFor();
    assert(await tid('paper-option-engineering').getAttribute('aria-checked') === 'true', '마지막 종이 기억');
    await shot('06-paper-new-note');
    await page.keyboard.press('Escape');
    await page.locator('[data-testid="note-card"]', { hasText: P }).click();
    await tid('palette').waitFor();
  });

  await check('손 입력: 손바닥을 대고 펜으로 써도 획이 남고 화면은 그대로, 손가락 탭으로 선택·글상자, 선택 안에서 끌면 옮기기, 두 손가락 확대', async () => {
    // 손가락은 CDP 터치, 펜은 CDP 마우스(pointerType pen). 단, Chromium 은 펜이 오면 진행 중인 터치를 취소해 버려서
    // (iPad 는 손바닥 터치를 그대로 둔다) 손바닥 → 펜 순서는 엔진 캔버스에 PointerEvent 를 직접 보내 재현한다.
    const cdp = await context.newCDPSession(page);
    const st = () => page.evaluate(() => {
      const e = window.__engine;
      return { n: e.strokes.length, tx: e.tx, ty: e.ty, scale: e.scale, sel: e.selectedStrokes().length, undo: e.undoStack.length };
    });
    const T = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
    const fingerTap = async ([x, y]) => { await T('touchStart', [{ x, y, id: 0 }]); await T('touchEnd', []); };
    const fingerDrag = async ([x0, y0], [x1, y1], steps = 10) => {
      await T('touchStart', [{ x: x0, y: y0, id: 0 }]);
      for (let i = 1; i <= steps; i++) await T('touchMove', [{ x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps, id: 0 }]);
      await T('touchEnd', []);
    };
    const samePts = (a, b) => a.every((p, i) => Math.abs(p[0] - b[i][0]) < 0.01 && Math.abs(p[1] - b[i][1]) < 0.01);
    // 펜을 쓴 뒤 1.5초 안에 닿은 손가락은 손바닥으로 의심(탭·옮기기 없음) — 손가락 동작을 볼 때는 그만큼 쉰다
    const settle = () => page.waitForTimeout(1600);
    /** 엔진 캔버스에 PointerEvent 를 직접 보낸다 (손바닥·펜 순서 재현). steps: [type, id, pointerType, clientX, clientY] | ms */
    const pointerSeq = (steps) => page.evaluate(async (steps) => {
      const c = window.__engine.canvas;
      for (const st of steps) {
        if (typeof st === 'number') { await new Promise((r) => setTimeout(r, st)); continue; }
        const [type, id, ptype, x, y] = st;
        c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: ptype, clientX: x, clientY: y, bubbles: true, cancelable: true,
          pressure: 0.5, buttons: type === 'pointerup' || type === 'pointercancel' || (ptype === 'pen' && type === 'pointermove' && id === 99) ? 0 : 1, button: 0, isPrimary: true }));
      }
    }, steps);
    const tableCenter = () => page.evaluate(() => {
      const e = window.__engine, t = e.strokes.find((s) => s.tool === 'table'), r = e.canvas.getBoundingClientRect();
      const [[x0, y0], [x1, y1]] = t.points;
      return { c: [r.left + ((x0 + x1) / 2) * e.scale + e.tx, r.top + ((y0 + y1) / 2) * e.scale + e.ty], pts: t.points.map((p) => p.slice()) };
    });

    // 손가락으로 쓰기 꺼짐 (펜이 닿으면 앱이 끈다) + 펜
    if ((await tid('tool-touch').getAttribute('aria-pressed')) === 'true') await tid('tool-touch').click();
    await tid('tool-pen').click();
    await page.evaluate(() => window.__engine.fitWidth());
    await settle();

    // 1) 손바닥이 먼저 닿고(가만히 → 조금 끌림) 펜으로 쓴다: 획이 남고, 펜이 닿은 뒤로는 손바닥이 화면을 끌지 않는다
    const palm = await page.evaluate(async () => {
      const e = window.__engine, c = e.canvas, b = c.getBoundingClientRect();
      const ev = (type, id, ptype, x, y) => c.dispatchEvent(new PointerEvent(type, {
        pointerId: id, pointerType: ptype, clientX: b.left + x, clientY: b.top + y, bubbles: true, cancelable: true,
        pressure: 0.5, buttons: type === 'pointerup' ? 0 : 1, button: 0, isPrimary: true }));
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const out = [];
      for (const palmDrift of [0, 40]) {
        const n0 = e.strokes.length;
        ev('pointerdown', 51, 'touch', 700, 600);
        await wait(50);
        for (let i = 1; i <= 4; i++) ev('pointermove', 51, 'touch', 700, 600 - palmDrift * i / 4); // 펜 전에 손바닥이 끌림
        const tyPen = e.ty;
        ev('pointerdown', 52, 'pen', 300, 300);
        for (let i = 1; i <= 10; i++) { ev('pointermove', 52, 'pen', 300 + i * 15, 300 + i * 3); ev('pointermove', 51, 'touch', 700, 600 - palmDrift - i * 8); }
        ev('pointerup', 52, 'pen', 450, 330);
        ev('pointermove', 51, 'touch', 700, 400);
        ev('pointerup', 51, 'touch', 700, 400);
        out.push({ palmDrift, added: e.strokes.length - n0, pts: e.strokes[e.strokes.length - 1].points.length, movedAfterPen: e.ty - tyPen, gesture: !!e.gesture, drawing: !!e.drawing });
        await wait(700);
      }
      return out;
    });
    for (const p of palm) {
      assert(p.added === 1 && p.pts >= 8, `손바닥(끌림 ${p.palmDrift}px) 뒤 펜 획이 남음 (${JSON.stringify(p)})`);
      assert(p.movedAfterPen === 0, `펜이 닿은 뒤 손바닥으로 화면이 움직이지 않음 (${p.movedAfterPen}px)`);
      assert(!p.gesture && !p.drawing, '입력 상태 정리');
    }

    // 2) 올가미 + 손가락 탭 → 누른 객체(표) 선택, 빈 곳 탭 → 선택 해제
    await page.evaluate(() => { const e = window.__engine; e.addTable({ rows: 2, cols: 2 }); e.clearSelection(); });
    await tid('tool-lasso').click();
    await settle();
    let t = await tableCenter();
    await fingerTap(t.c);
    await until(async () => /표 고치기/.test(await tid('edit-object').textContent().catch(() => '')), '손가락 탭으로 표 선택');
    assert((await st()).sel === 1, '하나 선택');

    // 3) 선택 안에서 손가락으로 끌면 옮겨진다(화면은 그대로), 실행 취소 한 번에 돌아온다
    let s0 = await st();
    await fingerDrag(t.c, [t.c[0] + 60, t.c[1] + 45]);
    let s1 = await st();
    const t1 = await tableCenter();
    const dx = t1.pts[0][0] - t.pts[0][0], dy = t1.pts[0][1] - t.pts[0][1];
    assert(Math.abs(dx - 60 / s0.scale) < 1 && Math.abs(dy - 45 / s0.scale) < 1, `표가 손가락만큼 옮겨짐 (${dx.toFixed(1)}, ${dy.toFixed(1)})`);
    assert(s1.tx === s0.tx && s1.ty === s0.ty, '옮기는 동안 화면은 그대로');
    assert(s1.undo === s0.undo + 1 && s1.sel === 1, '실행 취소 한 단계, 선택 유지');
    await tid('undo').click();
    assert(samePts((await tableCenter()).pts, t.pts), '실행 취소 → 제자리');

    // 3-1) 선택 안을 누르고 10px 안에서 흔들리기만 하면 옮기지 않는다 (실행 취소 기록 없음, 선택 유지)
    await page.evaluate(() => { const e = window.__engine; e.selectObject(e.strokes.find((s) => s.tool === 'table')); }); // 실행 취소가 선택을 푼다
    s0 = await st();
    assert(s0.sel === 1, '표 선택됨');
    await fingerDrag(t.c, [t.c[0] + 6, t.c[1] + 5], 6);
    s1 = await st();
    assert(samePts((await tableCenter()).pts, t.pts) && s1.undo === s0.undo && s1.sel === 1, `흔들림은 옮기지 않음 (undo ${s0.undo}→${s1.undo}, sel ${s1.sel})`);

    // 3-2) 손바닥이 선택한 표 위에 닿아 끌리다가 펜이 닿으면: 옮긴 것을 되돌린다 (표 그대로, 실행 취소 기록 없음)
    await settle();
    s0 = await st();
    const far = [t.c[0] - 250, t.c[1] + 260];
    await pointerSeq([['pointerdown', 61, 'touch', t.c[0], t.c[1]], 30,
      ...[1, 2, 3, 4, 5, 6].map((i) => ['pointermove', 61, 'touch', t.c[0] + i * 6, t.c[1] + i * 5])]);
    const movedByPalm = !samePts((await tableCenter()).pts, t.pts);
    await pointerSeq([['pointerdown', 62, 'pen', far[0], far[1]], ['pointerup', 62, 'pen', far[0], far[1]],
      ['pointermove', 61, 'touch', t.c[0] + 60, t.c[1] + 50], ['pointerup', 61, 'touch', t.c[0] + 60, t.c[1] + 50]]);
    s1 = await st();
    assert(movedByPalm, '(손바닥 끌기로 옮기기가 시작됐었다)');
    assert(samePts((await tableCenter()).pts, t.pts), '펜이 닿으면 손바닥이 옮긴 표를 되돌림');
    assert(s1.undo === s0.undo, `실행 취소 기록 없음 (${s0.undo}→${s1.undo})`);

    // 3-3) 손가락으로 옮기던 중 시스템 취소(pointercancel — iPadOS 손바닥 거르기) → 되돌림
    await page.evaluate(() => { const e = window.__engine; e.selectObject(e.strokes.find((s) => s.tool === 'table')); });
    await settle();
    s0 = await st();
    await pointerSeq([['pointerdown', 63, 'touch', t.c[0], t.c[1]], ...[1, 2, 3, 4, 5].map((i) => ['pointermove', 63, 'touch', t.c[0] + i * 8, t.c[1]]),
      ['pointercancel', 63, 'touch', t.c[0] + 40, t.c[1]]]);
    s1 = await st();
    assert(samePts((await tableCenter()).pts, t.pts) && s1.undo === s0.undo && !(await page.evaluate(() => !!window.__engine.drawing)), 'pointercancel → 되돌림, 기록 없음');

    // 3-4) 펜을 쓴 직후(1.5초 안) 빈 곳 손가락 탭 = 손바닥 의심 → 선택이 풀리지 않는다
    await pointerSeq([['pointermove', 99, 'pen', far[0], far[1]]]); // 펜 호버
    await page.waitForTimeout(700); // 0.6초 손바닥 무시는 지났고 1.5초 안
    await fingerTap([t.c[0], t.c[1] + 220]);
    assert((await st()).sel === 1, '펜 직후 탭은 선택 해제하지 않음');
    await settle();

    // 4) 선택 밖에서 끌면 화면 넘기기(표는 그대로), 빈 곳 탭 → 선택 해제
    t = await tableCenter();
    s0 = await st();
    const empty = [t.c[0], t.c[1] + 220];
    await fingerDrag(empty, [empty[0], empty[1] - 80]);
    s1 = await st();
    assert(Math.abs((s1.ty - s0.ty) + 80) < 1 && s1.tx === s0.tx, `선택 밖 끌기 = 화면 넘기기 (${(s1.ty - s0.ty).toFixed(1)})`);
    assert(samePts((await tableCenter()).pts, t.pts), '표는 그대로');
    await page.evaluate(() => window.__engine.fitWidth());
    t = await tableCenter();
    assert((await st()).sel === 1, '넘기는 동안 선택 유지');
    await fingerTap([t.c[0], t.c[1] + 220]);
    assert((await st()).sel === 0, '빈 곳 탭 → 선택 해제');

    // 5) 글상자 도구 + 손가락 탭 → 글상자가 열린다
    await tid('tool-text').click();
    await fingerTap([t.c[0], t.c[1] + 220]);
    await page.locator('textarea.hd-text-input').waitFor({ state: 'visible', timeout: 3000 });
    await page.keyboard.type('손가락 글상자');
    await tid('tool-pen').click(); // 확정
    assert(await page.evaluate(() => window.__engine.strokes.some((s) => s.tool === 'text' && s.text === '손가락 글상자')), '손가락으로 연 글상자에 쓴 글');

    // 6) 두 손가락 핀치 → 확대 (그리지 않음)
    s0 = await st();
    const [cx, cy] = t.c;
    await T('touchStart', [{ x: cx - 60, y: cy + 120, id: 0 }]);
    await T('touchStart', [{ x: cx - 60, y: cy + 120, id: 0 }, { x: cx + 60, y: cy + 120, id: 1 }]);
    for (let i = 1; i <= 10; i++) await T('touchMove', [{ x: cx - 60 - i * 10, y: cy + 120, id: 0 }, { x: cx + 60 + i * 10, y: cy + 120, id: 1 }]);
    await T('touchEnd', []);
    s1 = await st();
    assert(s1.scale > s0.scale * 1.5 && s1.n === s0.n, `핀치 확대 (${s0.scale.toFixed(2)} → ${s1.scale.toFixed(2)}), 획 없음`);
    await page.evaluate(() => window.__engine.fitWidth());
    await cdp.detach();
    await waitSaved();
    await shot('10-finger-input');
  });

  await check('사진·객체 배치: 확대와 상관없는 페이지 기준 크기, 페이지 밖으로 끌면 페이지 안으로(올린 페이지 그림에 잘리지 않음), 모서리 손잡이(펜·손가락, 비율 유지, 실행 취소 한 단계), 90° 회전, 페이지 아래에 넣으면 보이게, 가장자리 복제', async () => {
    const P = '사진 배치 노트';
    await tid('back').click();
    await newNote(P);
    const cdp = await context.newCDPSession(page);
    const E = (fn, arg) => page.evaluate(new Function('arg', `const e = window.__engine; return (${fn})(e, arg);`), arg);
    const st = () => E((e) => ({ tx: e.tx, ty: e.ty, scale: e.scale, n: e.strokes.length, undo: e.undoStack.length, sel: e.selectedStrokes().length }));
    const settle = () => page.waitForTimeout(1600); // 펜 뒤 1.5초 안의 손가락은 손바닥 의심
    /** 사진(단색 + 위쪽 흰 표시) JPEG — 앱 안 캔버스로 만든다 */
    const photo = async (color, w = 1200, h = 800) => Buffer.from((await page.evaluate(([color, w, h]) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h);
      x.fillStyle = '#ffffff'; x.fillRect(w * 0.45, 0, w * 0.1, h * 0.2); // 위쪽 표시 (돌리기 확인)
      return c.toDataURL('image/jpeg', 0.9);
    }, [color, w, h])).split(',')[1], 'base64');
    const RED = await photo('#c02020'), BLUE = await photo('#2040c0');
    /** i번째(음수면 뒤에서) 그림의 상자·페이지·화면에 보이는지 */
    const box = (i = -1) => E((e, i) => {
      const imgs = e.strokes.filter((s) => s.tool === 'image'), s = imgs[i < 0 ? imgs.length + i : i];
      const [[ax, ay], [bx, by]] = s.points, L = e.layout, stride = L.pageH + L.gap, pg = Math.floor(ay / stride);
      const I = e.insets, r = e.canvas.getBoundingClientRect();
      const sx0 = ax * e.scale + e.tx, sy0 = ay * e.scale + e.ty, sx1 = bx * e.scale + e.tx, sy1 = by * e.scale + e.ty;
      return { x: ax, y: ay, w: bx - ax, h: by - ay, page: pg, src: s.src.slice(-64),
        inPage: ax >= 0 && bx <= L.pageW && ay >= pg * stride && by <= pg * stride + L.pageH,
        visible: sx0 >= I.left && sy0 >= I.top && sx1 <= e.cssW - I.right && sy1 <= e.cssH - I.bottom,
        center: [r.left + (sx0 + sx1) / 2, r.top + (sy0 + sy1) / 2] };
    }, i);
    const insertPhoto = async (buffer) => {
      const n0 = (await st()).n;
      await tid('tool-insert').click();
      const fc = page.waitForEvent('filechooser');
      await tid('insert-photo').click();
      await (await fc).setFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer });
      await until(async () => (await st()).n > n0, '사진 넣기');
      await page.waitForTimeout(150);
      return box();
    };
    /** 펜 끌기 (CDP 마우스 pointerType pen) */
    const penDrag = async ([x0, y0], [x1, y1], steps = 20) => {
      const M = (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, pointerType: 'pen', force: 0.5, ...extra });
      await M('mouseMoved', x0, y0, { button: 'none' });
      await M('mousePressed', x0, y0, { button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= steps; i++) await M('mouseMoved', x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, { button: 'left', buttons: 1 });
      await M('mouseReleased', x1, y1, { button: 'left', buttons: 0, clickCount: 1 });
    };
    const T = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
    const fingerDrag = async ([x0, y0], [x1, y1], steps = 12) => {
      await T('touchStart', [{ x: x0, y: y0, id: 0 }]);
      for (let i = 1; i <= steps; i++) await T('touchMove', [{ x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps, id: 0 }]);
      await T('touchEnd', []);
    };
    const handle = async (corner) => {
      const [h, r] = await E((e) => [e.selectionHandles(), e.canvas.getBoundingClientRect().toJSON()]);
      const c = h.find((x) => x.corner === corner);
      assert(c, `손잡이 ${corner} (${JSON.stringify(h)})`);
      return [r.left + c.x, r.top + c.y];
    };

    // 1) 크기: 축소해서 넣든 확대해서 넣든 같은 크기(본문 폭 672 의 60%, 비율 그대로), 페이지 안
    await E((e) => { e.fitWidth(); e.zoomBy(0.4); });
    const zOut = await insertPhoto(RED);
    await E((e) => { e.fitWidth(); e.zoomBy(3); });
    const zIn = await insertPhoto(RED);
    assert(Math.abs(zOut.w - 403.2) < 0.1 && Math.abs(zOut.h - 268.8) < 0.1, `축소해서 넣은 사진 크기 (${zOut.w}×${zOut.h})`);
    assert(Math.abs(zIn.w - zOut.w) < 0.01 && Math.abs(zIn.h - zOut.h) < 0.01, `확대해서 넣어도 같은 크기 (${zIn.w}×${zIn.h})`);
    assert(zOut.inPage && zIn.inPage, '둘 다 페이지 안');
    await E((e) => { e.undo(); e.undo(); });
    assert((await st()).n === 0, '실행 취소로 비움');

    // 2) 1쪽 아래를 보며 넣기: 넣은 사진이 화면에 다 보인다 (두 번째는 자리가 없어 2쪽으로 → 화면이 따라간다)
    await E((e) => { e.fitWidth(); e.ty = e.cssH / 2 - (e.layout.pageH - 60) * e.scale; e.requestRender(true); });
    const b1 = await insertPhoto(RED);
    assert(b1.page === 0 && b1.inPage && b1.visible, `1쪽 아래에 넣은 사진이 보임 (${JSON.stringify(b1)})`);
    const b2 = await insertPhoto(BLUE);
    assert(b2.page === 1 && b2.inPage && b2.visible, `2쪽으로 간 사진도 화면이 따라가 보임 (${JSON.stringify(b2)})`);
    await E((e) => e.undo());

    // 3) 펜으로 사진을 1쪽 아래 경계 너머로 끌기(대부분 2쪽) → 2쪽 본문 맨 위로, 실행 취소 한 단계
    await E((e) => { e.fitWidth(); e.zoomBy(0.5, e.cssW / 2, 0); e.selectObject(e.strokes.find((s) => s.tool === 'image')); });
    let s0 = await st();
    const stride = await E((e) => e.layout.pageH + e.layout.gap);
    const a0 = await box(0);
    await penDrag(a0.center, [a0.center[0] + 120 * s0.scale, a0.center[1] + ((stride - a0.h * 0.3) - a0.y) * s0.scale]);
    const a1 = await box(0);
    let s1 = await st();
    assert(a1.page === 1 && a1.inPage && Math.abs(a1.y - (stride + 56)) < 0.01, `2쪽 본문 맨 위로 맞춤 (${JSON.stringify(a1)})`);
    assert(Math.abs(a1.w - a0.w) < 0.01 && s1.undo === s0.undo + 1, `크기 그대로, 실행 취소 한 단계 (${s0.undo}→${s1.undo})`);

    // 4) 다른 사진(1쪽): 펜으로 오른쪽 아래 모서리 손잡이 끌기 → 비율 유지, 실행 취소 한 단계로 되돌림
    await E((e) => e.fitWidth());
    const c0 = await insertPhoto(BLUE);
    assert(c0.page === 0, '두 번째 사진 1쪽');
    s0 = await st();
    const se = await handle('se');
    await penDrag(se, [se[0] + 80, se[1] + 10]);
    let c1 = await box();
    s1 = await st();
    assert(c1.w > c0.w + 40 && Math.abs(c1.w / c1.h - c0.w / c0.h) < 0.01, `펜 손잡이로 키움, 비율 유지 (${c0.w.toFixed(1)}→${c1.w.toFixed(1)}, ${(c1.w / c1.h).toFixed(3)})`);
    assert(Math.abs(c1.x - c0.x) < 0.01 && Math.abs(c1.y - c0.y) < 0.01, '반대쪽 모서리(왼쪽 위) 그대로');
    assert(s1.undo === s0.undo + 1, `펜 크기 바꾸기 실행 취소 한 단계 (${s0.undo}→${s1.undo})`);
    await tid('undo').click();
    const cu = await box();
    assert(Math.abs(cu.w - c0.w) < 0.01 && Math.abs(cu.h - c0.h) < 0.01, '실행 취소 → 처음 크기');
    await tid('redo').click();

    // 5) 손가락(손가락 쓰기 꺼짐)으로 왼쪽 위 손잡이를 바깥으로 → 비율 유지, 화면은 그대로, 실행 취소 한 단계
    if ((await tid('tool-touch').getAttribute('aria-pressed')) === 'true') await tid('tool-touch').click();
    await E((e) => e.selectObject(e.strokes.filter((s) => s.tool === 'image').pop()));
    await settle();
    c1 = await box();
    s0 = await st();
    const nw = await handle('nw');
    await fingerDrag([nw[0] - 4, nw[1] - 4], [nw[0] - 64, nw[1] - 44]);
    const c2 = await box();
    s1 = await st();
    assert(c2.w > c1.w + 20 && Math.abs(c2.w / c2.h - c1.w / c1.h) < 0.01, `손가락 손잡이로 키움, 비율 유지 (${c1.w.toFixed(1)}→${c2.w.toFixed(1)})`);
    assert(Math.abs((c2.x + c2.w) - (c1.x + c1.w)) < 0.01 && Math.abs((c2.y + c2.h) - (c1.y + c1.h)) < 0.01, '반대쪽 모서리(오른쪽 아래) 그대로');
    assert(s1.tx === s0.tx && s1.ty === s0.ty && s1.undo === s0.undo + 1, `화면 그대로, 실행 취소 한 단계 (${s0.undo}→${s1.undo})`);

    // 6) 90° 회전: 폭·높이가 바뀌고, 돌린 그림 데이터로 그려진다 (실행 취소 한 단계)
    await E((e) => { window.__origPhoto = e.strokes.filter((x) => x.tool === 'image').pop().src; });
    s0 = await st();
    await tid('sel-rotate').click();
    await until(async () => (await box()).src !== c2.src, '돌린 그림');
    const c3 = await box();
    s1 = await st();
    assert(Math.abs(c3.w - c2.h) < 0.02 && Math.abs(c3.h - c2.w) < 0.02 && c3.inPage, `폭·높이 바뀜 (${c2.w.toFixed(1)}×${c2.h.toFixed(1)} → ${c3.w.toFixed(1)}×${c3.h.toFixed(1)})`);
    assert(s1.undo === s0.undo + 1, '실행 취소 한 단계');
    const rotated = await E(async (e) => {
      const s = e.strokes.filter((x) => x.tool === 'image').pop(), img = e._getImage(s.src);
      if (!img.complete) await new Promise((r) => img.addEventListener('load', r, { once: true }));
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const at = (px, py) => Array.from(x.getImageData(px, py, 1, 1).data.slice(0, 3));
      return { jpeg: s.src.startsWith('data:image/jpeg'), w: img.naturalWidth, h: img.naturalHeight, right: at(img.naturalWidth - 20, img.naturalHeight / 2), left: at(20, img.naturalHeight / 2) };
    });
    // 1200×800 → 800×1200, 위쪽 흰 표시가 오른쪽으로 (시계 방향)
    assert(rotated.jpeg && rotated.w === 800 && rotated.h === 1200 && rotated.right.every((v) => v > 200) && rotated.left[2] > 150, `돌린 그림 픽셀 (${JSON.stringify(rotated)})`);
    await shot('11-rotated-photo');

    // 6-1) 두 번 눌러도 한 번(90°)만 돌고 실행 취소도 한 단계, 돌리는 사이 실행 취소하면 손대지 않음,
    //      돌린 그림은 원본에서 다시 돌려 네 바퀴째엔 원본 데이터 그대로 (화질 손실 누적 없음). 상자 비율 = 그림 비율
    const rr = await E(async (e) => {
      const s = e.strokes.filter((x) => x.tool === 'image').pop();
      const shape = async () => {
        const img = e._getImage(s.src);
        if (!img.complete) await new Promise((r) => img.addEventListener('load', r, { once: true }));
        const [[a, b], [c, d]] = s.points;
        return { w: c - a, h: d - b, nw: img.naturalWidth, nh: img.naturalHeight, ratioOk: Math.abs((c - a) / (d - b) - img.naturalWidth / img.naturalHeight) < 0.01 };
      };
      const out = { start: await shape(), u0: e.undoStack.length };
      out.double = await Promise.all([e.rotateImage(s), e.rotateImage(s)]);
      out.afterDouble = await shape();
      out.u1 = e.undoStack.length;
      const srcBefore = s.src;
      const p = e.rotateImage(s);
      e.undo(); // 돌리는 사이 실행 취소 → 앞의 돌리기를 되돌림
      out.duringUndo = await p;
      out.afterUndo = await shape();
      out.u2 = e.undoStack.length;
      out.undoRestored = s.src !== srcBefore;
      for (let i = 0; i < 3; i++) out[`r${i}`] = await e.rotateImage(s);
      out.end = await shape();
      out.backToOriginal = s.src === window.__origPhoto;
      e.selectObject(s); // 실행 취소가 선택을 풀었다
      return out;
    });
    const R = rr;
    assert(R.double[0] === true && R.double[1] === null && R.u1 === R.u0 + 1, `두 번 눌러도 한 번 (${JSON.stringify(R.double)}, undo ${R.u0}→${R.u1})`);
    assert(Math.abs(R.afterDouble.w - R.start.h) < 0.02 && Math.abs(R.afterDouble.h - R.start.w) < 0.02 && R.afterDouble.ratioOk, `90° 한 번, 비율 그대로 (${JSON.stringify(R.afterDouble)})`);
    assert(R.duringUndo === null && R.undoRestored && R.afterUndo.ratioOk && R.u2 === R.u0, `돌리는 사이 실행 취소 → 손대지 않음 (${JSON.stringify(R.afterUndo)})`);
    assert(R.r0 && R.r1 && R.r2 && R.backToOriginal && R.end.ratioOk && R.end.nw === 1200, `네 바퀴째 원본 데이터 (${JSON.stringify(R.end)})`);

    // 7) 펜으로 1쪽 오른쪽 아래 밖으로 끌기(대부분 1쪽) → 본문 오른쪽 아래 안으로, 그 자리에서 복제해도 페이지 안
    await E((e) => { e.fitWidth(); e.zoomBy(0.5, e.cssW / 2, 0); });
    const d0 = await box();
    s0 = await st();
    await penDrag(d0.center, [d0.center[0] + 400 * s0.scale, d0.center[1] + (1068 - d0.h * 0.8 - d0.y) * s0.scale]);
    const d1 = await box();
    assert(d1.page === 0 && d1.inPage && Math.abs(d1.x + d1.w - 696) < 0.02 && Math.abs(d1.y + d1.h - 1056) < 0.02, `1쪽 본문 오른쪽 아래로 맞춤 (${JSON.stringify(d1)})`);
    await tid('sel-duplicate').click();
    const dup = await box();
    s1 = await st();
    assert(s1.n === s0.n + 1 && dup.page === 0 && dup.inPage, `가장자리 복제도 페이지 안 (${JSON.stringify(dup)})`);

    // 8) 선택 막대는 선택한 것 바로 위(또는 아래)
    const bar = await tid('selection-bar').boundingBox();
    const sel = await E((e) => { const r = e.canvas.getBoundingClientRect(), b = e.selectionScreenBox(); return { top: r.top + b.y, bottom: r.top + b.y + b.h }; });
    assert(Math.abs(sel.top - (bar.y + bar.height) - 28) < 2 || Math.abs(bar.y - sel.bottom - 28) < 2, `선택 막대가 선택 옆 (${JSON.stringify(bar)} / ${JSON.stringify(sel)})`);
    await waitSaved();

    // 9) 버전을 올리면: 레이아웃의 모든 그림이 페이지 안, 2쪽 페이지 그림에 끌어 놓은 빨간 사진이 위·아래 끝까지 그려짐
    await saveVersion(/구노에 올렸습니다/);
    const n = await until(() => noteByTitle(P), '서버에 노트');
    const html = await (await fetch(`${MOCK}/versions/${n.versionIds[n.versionIds.length - 1]}`)).text();
    const docJson = JSON.parse(/data-strokes="([^"]+)"/.exec(html)[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    const Lu = docJson.layout, su = Lu.pageH + Lu.gap;
    const imgs = docJson.strokes.filter((s) => s.tool === 'image');
    assert(imgs.length === 3, `그림 3개 (${imgs.length})`);
    for (const s of imgs) {
      const [[ax, ay], [bx, by]] = s.points, pg = Math.floor(ay / su);
      assert(ax >= 0 && bx <= Lu.pageW && ay >= pg * su && by <= pg * su + Lu.pageH, `올린 그림이 페이지 안 (${JSON.stringify(s.points)})`);
    }
    const srcs = [...html.matchAll(/src="(\/editor-inline-images\/[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    assert(srcs.length === 2, `페이지 그림 2장 (${srcs.length})`);
    const png2 = Buffer.from(await (await fetch(MOCK + srcs[1])).arrayBuffer()).toString('base64');
    const red = imgs[0]; // 끌어 놓은 첫 사진 (2쪽)
    const px = await page.evaluate(async ([b64, pts, top, pageW]) => {
      const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
      const k = img.naturalWidth / pageW, c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const at = (wx, wy) => Array.from(x.getImageData(Math.round(wx * k), Math.round((wy - top) * k), 1, 1).data.slice(0, 3));
      const [[ax, ay], [bx, by]] = pts, cx = (ax + bx) / 2;
      return { top: at(cx - 100, ay + 3), bottom: at(cx, by - 3), below: at(cx, by + 6) };
    }, [png2, red.points, Math.floor(red.points[0][1] / su) * su, Lu.pageW]);
    const isRed = ([r, g, b]) => r > 150 && g < 90 && b < 90;
    assert(isRed(px.top) && isRed(px.bottom) && !isRed(px.below), `2쪽 페이지 그림에 사진이 잘리지 않고 그려짐 (${JSON.stringify(px)})`);
    await cdp.detach();
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
    // 잠긴 채 노트 화면에서 딥링크가 오면 다시 연결 화면이 열려 받는다(무시하지 않음). 다른 서버 QR 이라 원인 안내
    await openLink('goono-note://pair?server=https%3A%2F%2Fnext.example.org&code=K7Q2-M9XD');
    await tid('connect-error').waitFor();
    assert(/에 연결되어 있습니다/.test(await tid('connect-error').textContent()) && (await tid('connect-account').count()) === 1,
      '잠긴 상태의 딥링크 → 다시 연결 화면');
    await tid('connect').getByText('취소').click();
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
