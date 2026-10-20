// 모의 서버(mock-server/server.mjs)가 계약(docs/SYNC-API.md)의 과제별 연결·승인·재인증·연결 수명·재사용 ref 규칙대로
// 동작하는지 확인한다. 서버를 PORT=0 으로 띄워 실제 포트를 받아 fetch 한다.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let proc;
let base;
let imageDir;

before(async () => {
  imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-eln-test-'));
  proc = spawn(process.execPath, [path.join(appDir, 'mock-server', 'server.mjs')], {
    env: { ...process.env, PORT: '0', IMAGE_DIR: imageDir, PUBLIC_URL: '' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('모의 서버가 뜨지 않았습니다.')), 10_000);
    proc.stdout.on('data', (chunk) => {
      out += chunk;
      const m = /\[mock-eln\] http:\/\/localhost:(\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(`http://localhost:${m[1]}`); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`모의 서버 종료(${code})`)); });
  });
});
after(() => {
  proc?.kill();
  fs.rmSync(imageDir, { recursive: true, force: true });
});
beforeEach(async () => { await admin('/reset', {}); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, p, body, token) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 본문이 JSON 이 아님 */ }
  return { status: r.status, body: json, headers: r.headers };
}
const admin = (p, body) => call(body === undefined ? 'GET' : 'POST', `/__admin${p}`, body);
const api = (p, body, token) => call(body === undefined ? 'GET' : 'POST', `/api/app/v1${p}`, body, token);
const get = (p, token) => call('GET', `/api/app/v1${p}`, undefined, token);
const state = async () => (await admin('/state')).body;
const device = (id) => ({ id, name: '연구실 iPad', platform: 'ios', model: 'iPad14,5', appVersion: '0.2.0' });
const errCode = (r) => r.body?.error?.code;

async function issue(loginId, projectMno, extra = {}) {
  const r = await admin('/pairing-code', { loginId, projectMno, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
/** 과제 QR → pair(202) → 웹 승인 → 상태 확인(APPROVED) → 토큰 */
async function connect(loginId, projectMno, deviceId = 'dev-A') {
  const { code } = await issue(loginId, projectMno);
  const pair = await api('/devices/pair', { pairingCode: code, device: device(deviceId) });
  assert.equal(pair.status, 202, JSON.stringify(pair.body));
  const ok = await admin('/approve', { loginId });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const st = await api('/devices/pair/status', { requestToken: pair.body.requestToken });
  assert.equal(st.status, 200, JSON.stringify(st.body));
  assert.equal(st.body.status, 'APPROVED');
  return st.body.token;
}
async function createNote(token, projectMno, clientNoteId) {
  return api('/notes', { clientNoteId, projectMno, title: clientNoteId }, token);
}
const projectsOf = async (token) => (await get('/bootstrap', token)).body.projects;
const byMno = (list) => [...list].sort((a, b) => a.projectMno - b.projectMno);
const noteState = async (noteMno) => (await state()).notes.find((n) => n.noteMno === noteMno);
const linkOf = async (deviceId, loginId, projectMno) => {
  const s = await state();
  return s.links.find((l) => l.deviceId === deviceId && l.loginId === loginId && l.projectMno === projectMno);
};

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
/** 계약 §0.7 확인 번호: SHA-256(requestToken) hex 앞 8자 → 부호 없는 정수 % 10000, 4자리 */
const confirmNumberOf = (requestToken) => String(parseInt(sha(requestToken).slice(0, 8), 16) % 10000).padStart(4, '0');
/** 계약 §6 내용 해시 — images: [{ ref, bytes }] (업로드 + 재사용 모두) */
function contentHash(html, images) {
  const h = crypto.createHash('sha256');
  h.update(Buffer.from(html, 'utf8'));
  for (const img of [...images].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))) {
    h.update(Buffer.from(`\n${img.ref}:${sha(img.bytes)}`, 'utf8'));
  }
  return h.digest('hex');
}
const page = (...refs) => `<figure class="rw-drawing" data-strokes="{}">${refs.map((r) => `<img src="blob:goono-app/${r}">`).join('')}</figure>`;
/** uploads: 바이트를 보내는 이미지, reusedRefs: meta.reusedRefs, hashImages: 해시에 넣을 이미지(기본 = uploads) */
async function uploadVersion(token, noteMno, { clientVersionId, baseVersionId = null, html, uploads = [], reusedRefs, hashImages, rawReusedRefs }) {
  const meta = { clientVersionId, baseVersionId, contentHash: contentHash(html, hashImages ?? uploads),
    deviceWrittenAt: new Date().toISOString(), autoSave: false };
  if (reusedRefs !== undefined) meta.reusedRefs = reusedRefs;
  if (rawReusedRefs !== undefined) meta.reusedRefs = rawReusedRefs;
  const fd = new FormData();
  fd.append('meta', JSON.stringify(meta));
  fd.append('noteContent', html);
  for (const { ref, bytes } of uploads) {
    fd.append(`inlineImages[blob:goono-app/${ref}]`, new Blob([bytes], { type: 'image/png' }), `${ref}.png`);
  }
  const r = await fetch(`${base}/api/app/v1/notes/${noteMno}/versions`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  return { status: r.status, body: await r.json() };
}

test('project QR: preview does not consume, pair → 202 PENDING, approve → APPROVED token', async () => {
  const issued = await issue('researcher1', 3);
  assert.match(issued.code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
  assert.match(issued.qrPayload, /^goono-note:\/\/pair\?server=.+&code=/);
  assert.equal(issued.appEnabled, true);
  assert.equal(issued.userNm, '김연구');
  assert.equal(issued.projectNm, '시료 A 열처리');
  assert.ok(issued.expiresInSeconds > 290 && issued.expiresInSeconds <= 300);

  // 미리보기는 코드를 쓰지 않는다(두 번 해도 같다). 정규화(소문자·하이픈 없음)도 같다
  for (const c of [issued.code, issued.code.replace('-', '').toLowerCase()]) {
    const pv = await api('/devices/pair/preview', { pairingCode: c });
    assert.equal(pv.status, 200, JSON.stringify(pv.body));
    assert.deepEqual(pv.body.project, { projectMno: 3, name: '시료 A 열처리' });
    assert.deepEqual(pv.body.user, { userMno: 12, loginId: 'researcher1', name: '김연구' });
    assert.equal(pv.body.expiresAt, issued.expiresAt);
  }
  assert.equal((await state()).pairingCodes[0].usedAt, null);
  const bad = await api('/devices/pair/preview', { pairingCode: 'ZZZZ-ZZZZ' });
  assert.equal(bad.status, 401);
  assert.equal(errCode(bad), 'INVALID_PAIRING_CODE');

  const pair = await api('/devices/pair', { pairingCode: issued.code, device: device('dev-A') });
  assert.equal(pair.status, 202);
  assert.equal(pair.body.status, 'PENDING');
  assert.equal(typeof pair.body.requestToken, 'string');
  assert.equal(pair.body.token, undefined); // 토큰은 승인 뒤에만
  assert.ok(pair.body.expiresInSeconds > 590 && pair.body.expiresInSeconds <= 600);
  assert.deepEqual(pair.body.project, { projectMno: 3, name: '시료 A 열처리' });
  assert.deepEqual(pair.body.user, { userMno: 12, loginId: 'researcher1', name: '김연구' });
  // 확인 번호: 요청에서 정해지는 4자리 — 앱 대기 화면과 웹 승인 창(관리 상태)에 같은 값
  assert.match(pair.body.confirmNumber, /^\d{4}$/);
  assert.equal(pair.body.confirmNumber, confirmNumberOf(pair.body.requestToken));
  assert.equal((await state()).requests[0].confirmNumber, pair.body.confirmNumber);
  assert.ok((await state()).pairingCodes[0].usedAt);
  // 쓴 코드는 미리보기·연결 모두 401
  assert.equal(errCode(await api('/devices/pair/preview', { pairingCode: issued.code })), 'INVALID_PAIRING_CODE');
  assert.equal(errCode(await api('/devices/pair', { pairingCode: issued.code, device: device('dev-A') })), 'INVALID_PAIRING_CODE');

  const pending = await api('/devices/pair/status', { requestToken: pair.body.requestToken });
  assert.equal(pending.status, 200);
  assert.equal(pending.body.status, 'PENDING');
  assert.ok(pending.body.expiresInSeconds > 0);
  assert.equal(pending.body.token, undefined);
  const unknown = await api('/devices/pair/status', { requestToken: 'nope' });
  assert.equal(unknown.status, 401);
  assert.equal(errCode(unknown), 'UNAUTHORIZED');

  const decided = await admin('/approve', { loginId: 'researcher1' });
  assert.equal(decided.status, 200);
  assert.equal(decided.body.status, 'APPROVED');
  assert.equal(typeof decided.body.requestMno, 'number');
  assert.equal((await admin('/approve', { loginId: 'researcher1' })).status, 404); // 남은 대기 요청 없음

  const first = await api('/devices/pair/status', { requestToken: pair.body.requestToken });
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'APPROVED');
  assert.equal(first.body.offlineGraceDays, 14);
  assert.deepEqual(first.body.user, { userMno: 12, loginId: 'researcher1', name: '김연구' });
  assert.ok(first.body.token && first.body.tokenExpiresAt && first.body.serverTime);
  // 수령 기한 안의 상태 확인마다 새 토큰 — 앞 토큰은 무효
  const second = await api('/devices/pair/status', { requestToken: pair.body.requestToken });
  assert.equal(second.body.status, 'APPROVED');
  assert.notEqual(second.body.token, first.body.token);
  assert.equal(errCode(await get('/bootstrap', first.body.token)), 'UNAUTHORIZED');
  assert.equal((await get('/bootstrap', second.body.token)).status, 200);

  const s = await state();
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].kind, 'LINK');
  assert.equal(s.requests[0].status, 'APPROVED');
  assert.equal(s.links.length, 1);
  assert.equal(s.links[0].status, 'ACTIVE');
  assert.equal(s.links[0].projectMno, 3);
});

test('cancel → CANCELED, later status → 410 PAIRING_EXPIRED', async () => {
  const { code } = await issue('researcher1', 3);
  const pair = await api('/devices/pair', { pairingCode: code, device: device('dev-A') });
  const c = await api('/devices/pair/cancel', { requestToken: pair.body.requestToken });
  assert.equal(c.status, 200);
  assert.equal(c.body.status, 'CANCELED');
  const st = await api('/devices/pair/status', { requestToken: pair.body.requestToken });
  assert.equal(st.status, 410);
  assert.equal(errCode(st), 'PAIRING_EXPIRED');
  assert.equal((await admin('/approve', { loginId: 'researcher1' })).status, 404);
  assert.equal(errCode(await api('/devices/pair/cancel', { requestToken: 'nope' })), 'UNAUTHORIZED');
});

test('reject → 403 PAIRING_REJECTED', async () => {
  const { code } = await issue('researcher1', 3);
  const pair = await api('/devices/pair', { pairingCode: code, device: device('dev-A') });
  const d = await admin('/approve', { loginId: 'researcher1', decision: 'REJECT' });
  assert.equal(d.body.status, 'REJECTED');
  const st = await api('/devices/pair/status', { requestToken: pair.body.requestToken });
  assert.equal(st.status, 403);
  assert.equal(errCode(st), 'PAIRING_REJECTED');
  const s = await state();
  assert.equal(s.links.length, 0);
  assert.equal(s.devices.length, 0); // 거절은 기기 묶음도 만들지 않는다
});

test('approval window passed → 410 PAIRING_EXPIRED', async () => {
  await admin('/config', { requestTtlMs: 1 });
  const { code } = await issue('researcher1', 3);
  const pair = await api('/devices/pair', { pairingCode: code, device: device('dev-A') });
  assert.equal(pair.status, 202);
  await sleep(30);
  const st = await api('/devices/pair/status', { requestToken: pair.body.requestToken });
  assert.equal(st.status, 410);
  assert.equal(errCode(st), 'PAIRING_EXPIRED');
  assert.equal((await admin('/approve', { loginId: 'researcher1' })).status, 404); // 지난 요청은 승인할 수 없다
});

test('bootstrap lists only linked projects with linkStatus', async () => {
  const token = await connect('researcher1', 3);
  assert.deepEqual(await projectsOf(token), [{ projectMno: 3, name: '시료 A 열처리', writable: true, linkStatus: 'ACTIVE' }]);
  // 편집 불가 과제(5)를 연결하면 SUSPENDED·쓰기 불가로 함께 보인다(이름순)
  const token2 = await connect('researcher1', 5);
  assert.deepEqual(await projectsOf(token2), [
    { projectMno: 5, name: '2025 종료 과제 (읽기 전용)', writable: false, linkStatus: 'SUSPENDED' },
    { projectMno: 3, name: '시료 A 열처리', writable: true, linkStatus: 'ACTIVE' },
  ]);
  // 비밀번호 연결(보조 경로)은 토큰만 — 과제 연결은 만들지 않는다
  await admin('/config', { passwordLogin: true });
  const reg = await api('/devices/register', { loginId: 'researcher2', password: 'goono1234', device: device('dev-R') });
  assert.equal(reg.status, 200);
  assert.deepEqual(await projectsOf(reg.body.token), []);
  assert.equal(errCode(await createNote(reg.body.token, 3, 'r2-n1')), 'PROJECT_NOT_LINKED');
});

test('note in unlinked project → 403 PROJECT_NOT_LINKED', async () => {
  const token = await connect('researcher1', 3);
  const r4 = await createNote(token, 4, 'n4');
  assert.equal(r4.status, 403);
  assert.equal(errCode(r4), 'PROJECT_NOT_LINKED');
  assert.equal(errCode(await createNote(token, 999, 'n999')), 'PROJECT_NOT_LINKED');
  assert.equal((await createNote(token, 3, 'n3')).status, 201);
  // 편집 불가 과제의 연결 → PROJECT_SUSPENDED
  const token2 = await connect('researcher1', 5);
  const r5 = await createNote(token2, 5, 'n5');
  assert.equal(r5.status, 403);
  assert.equal(errCode(r5), 'PROJECT_SUSPENDED');
});

test('unlink returns device notes to WEB with history 연결 끊김', async () => {
  await connect('researcher1', 3);
  const token = await connect('researcher1', 4);
  const n3 = (await createNote(token, 3, 'n3')).body;
  const n4 = (await createNote(token, 4, 'n4')).body;
  const html = page();
  const v1 = await uploadVersion(token, n3.noteMno, { clientVersionId: 'cv-1', html });
  assert.equal(v1.status, 201);

  const u = await admin('/unlink', { deviceId: 'dev-A', loginId: 'researcher1', projectMno: 3 });
  assert.equal(u.status, 200);
  assert.equal(u.body.ended, 1);
  assert.equal((await admin('/unlink', { deviceId: 'dev-A', loginId: 'researcher1', projectMno: 3 })).body.ended, 0);

  const s3 = await noteState(n3.noteMno);
  assert.deepEqual(s3.editLocation, { type: 'WEB' });
  assert.ok(s3.history.some((h) => h.event === 'RECLAIMED' && h.reason === '연결 끊김' && h.by === 12), JSON.stringify(s3.history)); // 작성자 = 책임자(researcher1)
  // 책임자가 아닌 사람은 끊을 수 없다
  assert.equal((await admin('/unlink', { deviceId: 'dev-A', loginId: 'researcher1', projectMno: 4, leaderLoginId: 'researcher2' })).status, 403);
  assert.equal((await noteState(n4.noteMno)).editLocation.type, 'DEVICE');
  const link = await linkOf('dev-A', 'researcher1', 3);
  assert.equal(link.status, 'ENDED');
  assert.equal(link.endReason, 'LEADER');

  assert.deepEqual(byMno(await projectsOf(token)).map((p) => [p.projectMno, p.linkStatus, p.writable]), [[3, 'ENDED', false], [4, 'ACTIVE', true]]);
  // 끊긴 과제: 업로드·반납은 NOT_EDIT_OWNER 보다 먼저 403, 같은 clientVersionId 재전송은 200 duplicate
  const up = await uploadVersion(token, n3.noteMno, { clientVersionId: 'cv-2', baseVersionId: v1.body.versionId, html });
  assert.equal(up.status, 403);
  assert.equal(errCode(up), 'PROJECT_NOT_LINKED');
  const dup = await uploadVersion(token, n3.noteMno, { clientVersionId: 'cv-1', html });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.duplicate, true);
  const rel = await api(`/notes/${n3.noteMno}/release`, { lastVersionId: v1.body.versionId }, token);
  assert.equal(rel.status, 403);
  assert.equal(errCode(rel), 'PROJECT_NOT_LINKED');
  // 같은 clientNoteId 로 다시 만들면 연결 검사보다 먼저 200 기존 값
  const again = await createNote(token, 3, 'n3');
  assert.equal(again.status, 200);
  assert.equal(again.body.noteMno, n3.noteMno);
  assert.equal(errCode(await createNote(token, 3, 'n3-new')), 'PROJECT_NOT_LINKED');
});

test('second project QR (same user) adds a link', async () => {
  // 같은 (과제, 연구원)으로 새 QR을 만들면 그 이전 미사용 QR만 무효 — 다른 과제 QR은 그대로
  const a = await issue('researcher1', 3);
  const b = await issue('researcher1', 4);
  const c = await issue('researcher1', 3);
  assert.equal(errCode(await api('/devices/pair/preview', { pairingCode: a.code })), 'INVALID_PAIRING_CODE');
  assert.equal((await api('/devices/pair/preview', { pairingCode: b.code })).status, 200);
  assert.equal((await api('/devices/pair/preview', { pairingCode: c.code })).status, 200);

  const t1 = await connect('researcher1', 3);
  const n3 = (await createNote(t1, 3, 'n3')).body;
  const t2 = await connect('researcher1', 4);
  assert.deepEqual(byMno(await projectsOf(t2)).map((p) => [p.projectMno, p.linkStatus]), [[3, 'ACTIVE'], [4, 'ACTIVE']]);
  const s = await state();
  assert.equal(s.devices.length, 1);
  assert.equal(s.links.length, 2);
  assert.equal(new Set(s.links.map((l) => l.deviceMno)).size, 1);
  assert.equal((await noteState(n3.noteMno)).editLocation.type, 'DEVICE');
  assert.equal(errCode(await get('/bootstrap', t1)), 'UNAUTHORIZED'); // 새 토큰을 받으면 앞 토큰은 무효
});

test('other researcher approval ends previous links (다른 연구원이 기기 연결)', async () => {
  await connect('researcher1', 3);
  const r1token = await connect('researcher1', 4);
  assert.equal((await state()).links.filter((l) => l.status === 'ACTIVE').length, 2);
  const n = (await createNote(r1token, 3, 'r1-n')).body;

  // researcher2 는 과제 5 구성원이 아니다
  assert.equal((await admin('/pairing-code', { loginId: 'researcher2', projectMno: 5 })).status, 404);
  const t2 = await connect('researcher2', 3, 'dev-A');
  const s = await state();
  for (const p of [3, 4]) {
    const l = s.links.find((x) => x.loginId === 'researcher1' && x.projectMno === p);
    assert.equal(l.status, 'ENDED');
    assert.equal(l.endReason, 'HANDOVER');
  }
  const ns = s.notes.find((x) => x.noteMno === n.noteMno);
  assert.deepEqual(ns.editLocation, { type: 'WEB' });
  assert.ok(ns.history.some((h) => h.reason === '다른 연구원이 기기 연결'));
  assert.deepEqual(byMno(await projectsOf(r1token)).map((p) => [p.projectMno, p.linkStatus]), [[3, 'ENDED'], [4, 'ENDED']]);
  assert.deepEqual(await projectsOf(t2), [{ projectMno: 3, name: '시료 A 열처리', writable: true, linkStatus: 'ACTIVE' }]);
});

test('reauth with expired token keeps links; no live links → 403 NO_PROJECT_LINKS', async () => {
  await admin('/config', { tokenTtlMs: 60 });
  await connect('researcher1', 3);
  const token = await connect('researcher1', 4);
  await sleep(100);
  assert.equal(errCode(await get('/bootstrap', token)), 'TOKEN_EXPIRED');
  await admin('/config', { tokenTtlMs: null });

  assert.equal(errCode(await api('/devices/reauth', {})), 'UNAUTHORIZED');
  const re = await api('/devices/reauth', {}, token);
  assert.equal(re.status, 202, JSON.stringify(re.body));
  assert.equal(re.body.status, 'PENDING');
  assert.equal(typeof re.body.requestToken, 'string');
  assert.ok(re.body.expiresInSeconds > 590);
  assert.deepEqual(re.body.user, { userMno: 12, loginId: 'researcher1', name: '김연구' });
  assert.deepEqual(byMno(re.body.projects), [{ projectMno: 3, name: '시료 A 열처리' }, { projectMno: 4, name: '세포 배양 조건 최적화' }]);
  assert.equal(re.body.token, undefined);
  assert.equal(re.body.confirmNumber, confirmNumberOf(re.body.requestToken));
  const req = (await state()).requests.find((r) => r.status === 'PENDING');
  assert.equal(req.kind, 'REAUTH');
  assert.equal(req.confirmNumber, re.body.confirmNumber);

  assert.equal((await admin('/approve', { loginId: 'researcher1' })).body.status, 'APPROVED');
  const st = await api('/devices/pair/status', { requestToken: re.body.requestToken });
  assert.equal(st.body.status, 'APPROVED');
  const fresh = st.body.token;
  assert.deepEqual(byMno(await projectsOf(fresh)).map((p) => [p.projectMno, p.linkStatus]), [[3, 'ACTIVE'], [4, 'ACTIVE']]);
  // 재인증 토큰을 받으면 앞(만료된) 토큰은 더는 쓸 수 없다 — 재인증에도
  assert.equal(errCode(await get('/bootstrap', token)), 'UNAUTHORIZED');
  assert.equal(errCode(await api('/devices/reauth', {}, token)), 'UNAUTHORIZED');

  // 살아 있는 연결이 없으면 403 NO_PROJECT_LINKS
  await admin('/unlink', { deviceId: 'dev-A', loginId: 'researcher1', projectMno: 3 });
  await admin('/unlink', { deviceId: 'dev-A', loginId: 'researcher1', projectMno: 4 });
  const none = await api('/devices/reauth', {}, fresh);
  assert.equal(none.status, 403);
  assert.equal(errCode(none), 'NO_PROJECT_LINKS');
  // 사용 중지된 기기는 401 DEVICE_REVOKED
  await admin('/devices/dev-A/revoke', {});
  const revoked = await api('/devices/reauth', {}, fresh);
  assert.equal(revoked.status, 401);
  assert.equal(errCode(revoked), 'DEVICE_REVOKED');
});

test('revoke ends all links and returns notes to WEB (기기 사용 중지)', async () => {
  await connect('researcher1', 3);
  const token = await connect('researcher1', 4);
  const n3 = (await createNote(token, 3, 'n3')).body;
  const n4 = (await createNote(token, 4, 'n4')).body;
  await admin('/devices/dev-A/revoke', {});
  const s = await state();
  assert.ok(s.links.every((l) => l.status === 'ENDED' && l.endReason === 'REVOKED'));
  for (const n of [n3, n4]) {
    const ns = s.notes.find((x) => x.noteMno === n.noteMno);
    assert.deepEqual(ns.editLocation, { type: 'WEB' });
    assert.ok(ns.history.some((h) => h.reason === '기기 사용 중지'));
  }
  // 새 과제 QR 승인은 사용 중지를 풀지 않는다 — 토큰을 받을 때 풀린다
  const { code } = await issue('researcher1', 3);
  const pair = await api('/devices/pair', { pairingCode: code, device: device('dev-A') });
  await admin('/approve', { loginId: 'researcher1' });
  assert.equal((await state()).devices[0].revoked, true);
  assert.equal(errCode(await get('/bootstrap', token)), 'DEVICE_REVOKED');
  const st = await api('/devices/pair/status', { requestToken: pair.body.requestToken });
  assert.equal(st.body.status, 'APPROVED');
  assert.equal((await state()).devices[0].revoked, false);
  assert.deepEqual(byMno(await projectsOf(st.body.token)).map((p) => [p.projectMno, p.linkStatus]), [[3, 'ACTIVE'], [4, 'ENDED']]);
});

test('daily: closed project suspends then resumes, 31 days unseen ends (장기 미접속), removed member ends (구성원 제외)', async () => {
  await connect('researcher1', 3);
  const token = await connect('researcher1', 4);
  const n3 = (await createNote(token, 3, 'n3')).body;
  const n4 = (await createNote(token, 4, 'n4')).body;

  // 과제 종료: 작업 전에도 요청 시 SUSPENDED(403), 작업이 노트를 WEB으로 + 이력 "과제 종료"
  assert.equal((await admin('/projects/3/state', { editable: false })).status, 200);
  assert.deepEqual(byMno(await projectsOf(token)).map((p) => [p.projectMno, p.linkStatus, p.writable]), [[3, 'SUSPENDED', false], [4, 'ACTIVE', true]]);
  const up = await uploadVersion(token, n3.noteMno, { clientVersionId: 'cv-s', html: page() });
  assert.equal(up.status, 403);
  assert.equal(errCode(up), 'PROJECT_SUSPENDED');
  assert.equal(errCode(await createNote(token, 3, 'n3-new')), 'PROJECT_SUSPENDED');
  assert.deepEqual((await admin('/daily', {})).body, { suspended: 1, resumed: 0, ended: 0 });
  assert.deepEqual((await noteState(n3.noteMno)).editLocation, { type: 'WEB' });
  assert.ok((await noteState(n3.noteMno)).history.some((h) => h.reason === '과제 종료'));
  assert.equal((await noteState(n4.noteMno)).editLocation.type, 'DEVICE');
  assert.equal((await linkOf('dev-A', 'researcher1', 3)).status, 'SUSPENDED');
  assert.deepEqual((await admin('/daily', {})).body, { suspended: 0, resumed: 0, ended: 0 }); // 다시 돌려도 변화 없음

  // 다시 편집 가능 → 새 QR 없이 재개
  await admin('/projects/3/state', { editable: true });
  assert.deepEqual((await admin('/daily', {})).body, { suspended: 0, resumed: 1, ended: 0 });
  assert.equal((await linkOf('dev-A', 'researcher1', 3)).status, 'ACTIVE');
  assert.equal((await createNote(token, 3, 'n3-again')).status, 201);

  // 구성원 제외: 요청 시 곧바로 ENDED 로 보이고, 작업이 기록(구성원 제외)
  assert.equal((await admin('/projects/4/remove-member', { loginId: 'researcher1' })).status, 200);
  assert.equal(errCode(await createNote(token, 4, 'n4-new')), 'PROJECT_NOT_LINKED');
  assert.deepEqual((await admin('/daily', {})).body, { suspended: 0, resumed: 0, ended: 1 });
  const l4 = await linkOf('dev-A', 'researcher1', 4);
  assert.equal(l4.status, 'ENDED');
  assert.equal(l4.endReason, 'MEMBER_REMOVED');
  assert.deepEqual((await noteState(n4.noteMno)).editLocation, { type: 'WEB' });
  assert.ok((await noteState(n4.noteMno)).history.some((h) => h.reason === '구성원 제외'));

  // 장기 미접속: 29일은 그대로, 31일이면 그 기기의 모든 연결 끊김(이력 "장기 미접속")
  const t2 = await connect('researcher2', 4, 'dev-B');
  const nb = (await createNote(t2, 4, 'r2-n')).body;
  assert.equal((await admin('/devices/dev-B/last-seen', { loginId: 'researcher2', daysAgo: 29 })).status, 200);
  assert.deepEqual((await admin('/daily', {})).body, { suspended: 0, resumed: 0, ended: 0 });
  await admin('/devices/dev-B/last-seen', { loginId: 'researcher2', daysAgo: 31 });
  assert.deepEqual((await admin('/daily', {})).body, { suspended: 0, resumed: 0, ended: 1 });
  const lb = await linkOf('dev-B', 'researcher2', 4);
  assert.equal(lb.status, 'ENDED');
  assert.equal(lb.endReason, 'INACTIVE');
  assert.ok((await noteState(nb.noteMno)).history.some((h) => h.reason === '장기 미접속'));

  // 우선순위: 구성원 아님 + 미접속 → 구성원 제외
  await admin('/projects/3/remove-member', { loginId: 'researcher1' });
  await admin('/devices/dev-A/last-seen', { loginId: 'researcher1', daysAgo: 40 });
  assert.deepEqual((await admin('/daily', {})).body, { suspended: 0, resumed: 0, ended: 1 });
  assert.equal((await linkOf('dev-A', 'researcher1', 3)).endReason, 'MEMBER_REMOVED');
});

test('reusedRefs: stored ref accepted and counted in hash; unknown → 400 REUSED_REF_MISSING; overlap → 400 INVALID_REQUEST', async () => {
  const token = await connect('researcher1', 3);
  const note = (await createNote(token, 3, 'n-reuse')).body;
  const A = { ref: 'page-aaaaaaaaaaaaaaaa', bytes: Buffer.from('png-bytes-A') };
  const B = { ref: 'page-bbbbbbbbbbbbbbbb', bytes: Buffer.from('png-bytes-B') };
  const C = { ref: 'page-cccccccccccccccc', bytes: Buffer.from('png-bytes-C') };
  const v1 = await uploadVersion(token, note.noteMno, { clientVersionId: 'v1', html: page(A.ref, B.ref), uploads: [A, B] });
  assert.equal(v1.status, 201, JSON.stringify(v1.body));
  const latest = v1.body.versionId;
  const html2 = page(A.ref, C.ref);

  // 재사용 바이트를 빼고 계산한 해시 → 422
  const noReuseHash = await uploadVersion(token, note.noteMno, { clientVersionId: 'v2x', baseVersionId: latest, html: html2, uploads: [C], reusedRefs: [A.ref] });
  assert.equal(noReuseHash.status, 422);
  assert.equal(errCode(noReuseHash), 'HASH_MISMATCH');
  // 저장되지 않은 ref 재사용 → REUSED_REF_MISSING
  const D = 'page-dddddddddddddddd';
  const missing = await uploadVersion(token, note.noteMno, { clientVersionId: 'v2m', baseVersionId: latest, html: page(D, C.ref), uploads: [C], reusedRefs: [D] });
  assert.equal(missing.status, 400);
  assert.equal(errCode(missing), 'REUSED_REF_MISSING');
  // 업로드 필드와 겹침 → INVALID_REQUEST
  const overlap = await uploadVersion(token, note.noteMno, { clientVersionId: 'v2o', baseVersionId: latest, html: html2, uploads: [A, C], reusedRefs: [A.ref] });
  assert.equal(overlap.status, 400);
  assert.equal(errCode(overlap), 'INVALID_REQUEST');
  // 본문의 blob ref 가 업로드·재사용 어디에도 없음 → INVALID_REQUEST (REUSED_REF_MISSING 보다 먼저)
  const dangling = await uploadVersion(token, note.noteMno, { clientVersionId: 'v2d', baseVersionId: latest, html: page(A.ref, C.ref), uploads: [C], reusedRefs: [D], hashImages: [C] });
  assert.equal(dangling.status, 400);
  assert.equal(errCode(dangling), 'INVALID_REQUEST');
  // 형식이 틀린 reusedRefs → BAD_REQUEST, ref 규칙 위반 → INVALID_REQUEST
  assert.equal(errCode(await uploadVersion(token, note.noteMno, { clientVersionId: 'v2b', baseVersionId: latest, html: html2, uploads: [C], rawReusedRefs: A.ref })), 'BAD_REQUEST');
  assert.equal(errCode(await uploadVersion(token, note.noteMno, { clientVersionId: 'v2c', baseVersionId: latest, html: html2, uploads: [C], rawReusedRefs: [A.ref, 7] })), 'BAD_REQUEST');
  assert.equal(errCode(await uploadVersion(token, note.noteMno, { clientVersionId: 'v2r', baseVersionId: latest, html: page('short', C.ref), uploads: [C], reusedRefs: ['short'] })), 'INVALID_REQUEST');

  // 정상: C 만 바이트로, A 는 재사용 — 해시엔 A 의 저장 바이트가 들어간다
  const v2 = await uploadVersion(token, note.noteMno, { clientVersionId: 'v2', baseVersionId: latest, html: html2, uploads: [C], reusedRefs: [A.ref], hashImages: [A, C] });
  assert.equal(v2.status, 201, JSON.stringify(v2.body));
  const s = await state();
  const ver = s.versions.find((v) => v.versionId === v2.body.versionId);
  assert.deepEqual(ver.uploadedImages, [C.ref]);
  assert.deepEqual(ver.reusedImages, [A.ref]);
  assert.equal(ver.inlineImagePaths, 2);
  const v1s = s.versions.find((v) => v.versionId === latest);
  assert.deepEqual(v1s.uploadedImages, [A.ref, B.ref]);
  assert.deepEqual(v1s.reusedImages, []);
  // 같은 ref 다른 바이트(업로드) → INVALID_REQUEST
  const diff = await uploadVersion(token, note.noteMno, { clientVersionId: 'v3x', baseVersionId: v2.body.versionId, html: page(A.ref), uploads: [{ ref: A.ref, bytes: Buffer.from('other') }] });
  assert.equal(errCode(diff), 'INVALID_REQUEST');

  // 저장 이미지 기록을 지우면 재사용은 REUSED_REF_MISSING
  assert.equal((await admin(`/notes/${note.noteMno}/forget-images`, {})).status, 200);
  const gone = await uploadVersion(token, note.noteMno, { clientVersionId: 'v3', baseVersionId: v2.body.versionId, html: page(A.ref), reusedRefs: [A.ref], hashImages: [A] });
  assert.equal(gone.status, 400);
  assert.equal(errCode(gone), 'REUSED_REF_MISSING');
});

test('approved but not collected within the delivery window → 410 PAIRING_EXPIRED', async () => {
  await admin('/config', { deliveryTtlMs: 1 });
  const { code } = await issue('researcher1', 3);
  const pair = await api('/devices/pair', { pairingCode: code, device: device('dev-A') });
  assert.equal((await admin('/approve', { loginId: 'researcher1' })).body.status, 'APPROVED');
  await sleep(30);
  const st = await api('/devices/pair/status', { requestToken: pair.body.requestToken });
  assert.equal(st.status, 410);
  assert.equal(errCode(st), 'PAIRING_EXPIRED');
});

test('another user approving leaves the request untouched', async () => {
  const { code } = await issue('researcher1', 3);
  const pair = await api('/devices/pair', { pairingCode: code, device: device('dev-A') });
  assert.equal((await admin('/approve', { loginId: 'researcher2' })).status, 404);
  assert.equal((await admin('/approve', { loginId: 'researcher2', decision: 'REJECT' })).status, 404);
  const st = await api('/devices/pair/status', { requestToken: pair.body.requestToken });
  assert.equal(st.body.status, 'PENDING');
  assert.equal((await state()).requests[0].status, 'PENDING');
  assert.equal((await admin('/approve', { loginId: 'researcher1' })).body.status, 'APPROVED');
});

test('preview failures share the IP limit with pair', async () => {
  const { code } = await issue('researcher1', 3);
  for (let i = 0; i < 3; i++) assert.equal(errCode(await api('/devices/pair/preview', { pairingCode: 'ZZZZ-ZZZZ' })), 'INVALID_PAIRING_CODE');
  for (let i = 0; i < 2; i++) assert.equal(errCode(await api('/devices/pair', { pairingCode: 'ZZZZ-ZZZZ', device: device('dev-A') })), 'INVALID_PAIRING_CODE');
  const pv = await api('/devices/pair/preview', { pairingCode: code }); // 맞는 코드도 막힘
  assert.equal(pv.status, 429);
  assert.equal(errCode(pv), 'TOO_MANY_ATTEMPTS');
  assert.ok(Number(pv.headers.get('retry-after')) > 0);
  assert.equal(errCode(await api('/devices/pair', { pairingCode: code, device: device('dev-A') })), 'TOO_MANY_ATTEMPTS');
  assert.equal((await state()).pairingCodes[0].usedAt, null);
});

test('a ref stored in another note → REUSED_REF_MISSING', async () => {
  const token = await connect('researcher1', 3);
  const n1 = (await createNote(token, 3, 'n1')).body;
  const n2 = (await createNote(token, 3, 'n2')).body;
  const A = { ref: 'page-aaaaaaaaaaaaaaaa', bytes: Buffer.from('png-bytes-A') };
  assert.equal((await uploadVersion(token, n1.noteMno, { clientVersionId: 'n1v1', html: page(A.ref), uploads: [A] })).status, 201);
  const r = await uploadVersion(token, n2.noteMno, { clientVersionId: 'n2v1', html: page(A.ref), reusedRefs: [A.ref], hashImages: [A] });
  assert.equal(r.status, 400);
  assert.equal(errCode(r), 'REUSED_REF_MISSING');
});

test('revoke cancels in-flight requests; new QR + approval still works', async () => {
  await connect('researcher1', 3);
  const token = await connect('researcher1', 4);
  // 훔친 토큰으로 재인증 요청, 같은 기기 ID로 과제 QR 연결 요청
  const re = await api('/devices/reauth', {}, token);
  assert.equal(re.status, 202);
  const { code } = await issue('researcher1', 3);
  const link = await api('/devices/pair', { pairingCode: code, device: device('dev-A') });
  assert.equal(link.status, 202);
  // 연구원이 잘못 승인(가장 오래된 = 재인증), 도둑이 한 번 받아 감
  assert.equal((await admin('/approve', { loginId: 'researcher1' })).body.status, 'APPROVED');
  const stolen = await api('/devices/pair/status', { requestToken: re.body.requestToken });
  assert.equal(stolen.body.status, 'APPROVED');

  await admin('/devices/dev-A/revoke', {});
  const s = await state();
  // 앞의 두 연결 승인도 아직 수령 기한 안이라(다시 확인하면 새 토큰) 함께 CANCELED
  assert.deepEqual(s.requests.map((r) => r.status), ['CANCELED', 'CANCELED', 'CANCELED', 'CANCELED'], JSON.stringify(s.requests));
  for (const t of [re.body.requestToken, link.body.requestToken]) {
    const st = await api('/devices/pair/status', { requestToken: t });
    assert.equal(st.status, 410);
    assert.equal(errCode(st), 'PAIRING_EXPIRED');
  }
  assert.equal((await admin('/approve', { loginId: 'researcher1' })).status, 404);
  assert.equal((await state()).devices[0].revoked, true);
  assert.equal(errCode(await get('/bootstrap', stolen.body.token)), 'DEVICE_REVOKED');

  // 정상 경로: 사용 중지 뒤 새 과제 QR → 승인 → 토큰(사용 중지 풀림)
  const fresh = await connect('researcher1', 3);
  assert.equal((await state()).devices[0].revoked, false);
  assert.deepEqual(byMno(await projectsOf(fresh)).map((p) => [p.projectMno, p.linkStatus]), [[3, 'ACTIVE'], [4, 'ENDED']]);
});

test('register does not restore links or lift a revoke', async () => {
  await admin('/config', { passwordLogin: true });
  const reg = (id, loginId = 'researcher1') => api('/devices/register', { loginId, password: 'goono1234', device: device(id) });
  await connect('researcher1', 3); // dev-A: 살아 있는 연결
  const linked = await reg('dev-A');
  assert.equal(linked.status, 409);
  assert.equal(errCode(linked), 'DEVICE_ALREADY_LINKED');
  await admin('/devices/dev-A/revoke', {});
  const revoked = await reg('dev-A');
  assert.equal(revoked.status, 401);
  assert.equal(errCode(revoked), 'DEVICE_REVOKED');
  assert.equal((await state()).devices.find((d) => d.deviceId === 'dev-A').revoked, true);
  // 살아 있는 연결이 없는(끊긴) 묶음은 토큰만 — 끊긴 과제는 ENDED 로 보인다
  await connect('researcher2', 4, 'dev-C');
  await admin('/unlink', { deviceId: 'dev-C', loginId: 'researcher2', projectMno: 4 });
  const ended = await reg('dev-C', 'researcher2');
  assert.equal(ended.status, 200);
  assert.deepEqual(await projectsOf(ended.body.token), [{ projectMno: 4, name: '세포 배양 조건 최적화', writable: false, linkStatus: 'ENDED' }]);
  const fresh = await reg('dev-N');
  assert.equal(fresh.status, 200);
  assert.deepEqual(await projectsOf(fresh.body.token), []);
});

test('live links for reauth use effective status', async () => {
  await connect('researcher1', 3);
  await connect('researcher1', 4);
  const token = await connect('researcher1', 5); // 편집 불가 과제 → SUSPENDED 도 살아 있다
  await admin('/projects/3/remove-member', { loginId: 'researcher1' }); // 저장 상태는 ACTIVE 지만 실제로는 끊김
  const re = await api('/devices/reauth', {}, token);
  assert.equal(re.status, 202);
  assert.deepEqual(byMno(re.body.projects).map((p) => p.projectMno), [4, 5]);
  await admin('/projects/4/remove-member', { loginId: 'researcher1' });
  await admin('/projects/5/remove-member', { loginId: 'researcher1' });
  const none = await api('/devices/reauth', {}, token);
  assert.equal(none.status, 403);
  assert.equal(errCode(none), 'NO_PROJECT_LINKS');
});

test('token delivery refreshes last seen (re-linked idle bundle is not ended as inactive)', async () => {
  await admin('/config', { tokenTtlMs: 60 });
  const token = await connect('researcher1', 3);
  await admin('/config', { tokenTtlMs: null });
  await admin('/devices/dev-A/last-seen', { loginId: 'researcher1', daysAgo: 40 });
  await sleep(100);
  const re = await api('/devices/reauth', {}, token);
  await admin('/approve', { loginId: 'researcher1' });
  assert.equal((await api('/devices/pair/status', { requestToken: re.body.requestToken })).body.status, 'APPROVED');
  assert.deepEqual((await admin('/daily', {})).body, { suspended: 0, resumed: 0, ended: 0 });
  assert.equal((await linkOf('dev-A', 'researcher1', 3)).status, 'ACTIVE');
});
