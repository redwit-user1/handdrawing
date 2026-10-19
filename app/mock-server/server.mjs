/**
 * 구노 ELN 동기화 API(v1) 모의 서버 — 앱 개발·E2E 테스트용.
 * 계약: ../docs/SYNC-API.md. 실제 구현은 Goono-ELN에 한다.
 *
 *   node mock-server/server.mjs            (기본 포트 8787)
 *   PORT=8787 OFFLINE_GRACE_DAYS=14 node mock-server/server.mjs
 *   PUBLIC_URL=https://eln.example.com     (QR 내용에 넣을 서버 주소. 기본은 요청의 Host)
 *
 * 테스트 계정: researcher1 / goono1234 (userMno 12), researcher2 / goono1234 (userMno 13)
 * 연결(QR): POST /__admin/pairing-code {loginId, ttlMs?} 로 연결 코드·QR 내용을 받고,
 *           앱은 POST /api/app/v1/devices/pair 로 연결한다. (비밀번호 /devices/register 는 보조 경로)
 * 확인 화면: http://localhost:8787/  (구노 웹 대신 받은 노트·버전을 보여준다)
 * 관리(테스트용): /__admin/* — 연결 코드 발급, 편집권 회수, 상태 변경, 기기 폐기, 토큰 기한 조정,
 *                 설정(passwordLogin·appEnabled·blockedDeviceIds)
 */
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const IMAGE_DIR = process.env.IMAGE_DIR || path.join(here, '.data', 'editor-inline-images');
const BLOB_PREFIX = 'blob:goono-app/';
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

fs.mkdirSync(IMAGE_DIR, { recursive: true });

const USERS = [
  { userMno: 12, loginId: 'researcher1', password: 'goono1234', name: '김연구' },
  { userMno: 13, loginId: 'researcher2', password: 'goono1234', name: '이연구' },
];
const PROJECTS = [
  { projectMno: 3, name: '시료 A 열처리', writable: true },
  { projectMno: 4, name: '세포 배양 조건 최적화', writable: true },
  { projectMno: 5, name: '2025 종료 과제 (읽기 전용)', writable: false },
];

// 연결 코드: 8자, 0·O·1·I·L 제외. 저장·비교는 대문자로 바꾸고 '-'·공백을 지운 값.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;
const PAIRING_TTL_MS = 5 * 60_000;
const FAIL_LIMIT = 5; // 같은 IP에서
const FAIL_WINDOW_MS = 10 * 60_000; // 10분 안에
const normalizeCode = (s) => String(s ?? '').toUpperCase().replace(/[-\s]/g, '');
const displayCode = (norm) => `${norm.slice(0, 4)}-${norm.slice(4)}`;
const deviceKey = (deviceId, userMno) => `${deviceId}:${userMno}`;

const defaultConfig = () => ({
  offlineGraceDays: Number(process.env.OFFLINE_GRACE_DAYS || 14),
  tokenTtlMs: null,
  passwordLogin: true, // 서버 설정 app.device.password-login.enabled
  appEnabled: true, // 기관이 태블릿 연결을 켰는가
  blockedDeviceIds: [],
});
let config = defaultConfig();
let state;
function reset() {
  state = {
    devices: new Map(), // key: `${deviceId}:${userMno}`
    notes: new Map(), versions: new Map(), clientVersions: new Map(), seq: { note: 100, version: 5000 },
    pairingCodes: new Map(), // key: 정규화된 코드
    pairFailures: new Map(), // key: IP → 실패 시각(ms) 목록
  };
}
reset();

const now = () => new Date();
const iso = (d) => d.toISOString();
const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const err = (res, status, code, message, extra = {}) => res.status(status).json({ error: { code, message }, ...extra });
const userView = (u) => ({ userMno: u.userMno, loginId: u.loginId, name: u.name });

function issueToken(device) {
  const token = crypto.randomBytes(24).toString('base64url');
  const ttl = config.tokenTtlMs ?? config.offlineGraceDays * 86400_000;
  device.tokenHash = sha256hex(token);
  device.tokenExpiresAt = new Date(Date.now() + ttl);
  return { token, tokenExpiresAt: iso(device.tokenExpiresAt), offlineGraceDays: config.offlineGraceDays, serverTime: iso(now()) };
}

/** 기기 기록은 (기기 ID, 사용자) 단위. 같은 사용자가 다시 연결하면 토큰만 새로 발급, 다른 사용자면 새 묶음. */
function bindDevice(device, user) {
  const key = deviceKey(device.id, user.userMno);
  const d = state.devices.get(key) || { deviceId: device.id, userMno: user.userMno };
  Object.assign(d, { name: device.name, platform: device.platform, model: device.model,
    appVersion: device.appVersion, revoked: false, registeredAt: d.registeredAt || now(), lastSeenAt: now() });
  state.devices.set(key, d);
  return d;
}

function auth(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  if (!m) return err(res, 401, 'UNAUTHORIZED', '기기 토큰이 필요합니다.');
  const hash = sha256hex(m[1]);
  const device = [...state.devices.values()].find((d) => d.tokenHash === hash);
  if (!device) return err(res, 401, 'UNAUTHORIZED', '알 수 없는 토큰입니다.');
  if (device.revoked) return err(res, 401, 'DEVICE_REVOKED', '이 기기는 사용이 중지되었습니다.');
  if (device.tokenExpiresAt < now()) return err(res, 401, 'TOKEN_EXPIRED', '다시 로그인하세요.');
  device.lastSeenAt = now();
  req.device = device;
  req.user = USERS.find((u) => u.userMno === device.userMno);
  next();
}

/** 편집 위치가 이 기기·이 사용자인 노트인가 (같은 기기를 다른 사용자가 연결해도 남의 노트를 건드리지 못한다) */
const ownsNote = (req, note) => note.editLocation.type === 'DEVICE'
  && note.editLocation.deviceId === req.device.deviceId && note.ownerMno === req.user.userMno;

const noteView = (n) => ({
  noteMno: n.noteMno, clientNoteId: n.clientNoteId, title: n.title, projectMno: n.projectMno,
  status: n.status, editLocation: n.editLocation, latestVersionId: n.latestVersionId, updatedAt: iso(n.updatedAt),
});

/** 앱과 같은 규칙의 내용 해시 */
function contentHash(noteContent, images) {
  const h = crypto.createHash('sha256');
  h.update(Buffer.from(noteContent, 'utf8'));
  for (const img of [...images].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))) {
    h.update(Buffer.from(`\n${img.ref}:${sha256hex(img.buffer)}`, 'utf8'));
  }
  return h.digest('hex');
}

const app = express();
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', req.get('origin') || '*');
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Expose-Headers', 'Retry-After');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '2mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, fieldSize: 60 * 1024 * 1024 } });

const api = express.Router();

// 기관이 태블릿 연결을 끄면(appEnabled:false) 모든 /api/app/v1 요청이 403 APP_DISABLED
api.use((_req, res, next) => (config.appEnabled === false
  ? err(res, 403, 'APP_DISABLED', '이 기관은 태블릿 연결을 사용하지 않습니다.')
  : next()));

// 보조 경로 — 서버 설정(app.device.password-login.enabled)이 켜졌을 때만
api.post('/devices/register', (req, res) => {
  if (config.passwordLogin === false) return err(res, 403, 'PASSWORD_LOGIN_DISABLED', '비밀번호 로그인은 사용할 수 없습니다. QR로 연결하세요.');
  const { loginId, password, device } = req.body || {};
  const user = USERS.find((u) => u.loginId === loginId && u.password === password);
  if (!user) return err(res, 401, 'INVALID_CREDENTIALS', '아이디 또는 비밀번호가 올바르지 않습니다.');
  if (!device?.id) return err(res, 400, 'BAD_REQUEST', 'device.id가 필요합니다.');
  if ((config.blockedDeviceIds || []).includes(device.id)) return err(res, 403, 'DEVICE_NOT_ALLOWED', '이 기기는 연결할 수 없습니다.');
  const d = bindDevice(device, user);
  res.json({ ...issueToken(d), user: userView(user) });
});

/** 같은 IP에서 10분 안에 5번 실패하면 막는다. 막혀 있으면 풀릴 때까지 남은 초, 아니면 0 */
function pairRetryAfter(ip) {
  const cutoff = Date.now() - FAIL_WINDOW_MS;
  const fails = (state.pairFailures.get(ip) || []).filter((t) => t > cutoff);
  state.pairFailures.set(ip, fails);
  return fails.length >= FAIL_LIMIT ? Math.max(1, Math.ceil((fails[0] + FAIL_WINDOW_MS - Date.now()) / 1000)) : 0;
}

// QR 연결 — 익명. 웹에서 발급한 일회용 코드로 기기 토큰을 받는다.
api.post('/devices/pair', (req, res) => {
  const { pairingCode, device } = req.body || {};
  if (!device?.id) return err(res, 400, 'BAD_REQUEST', 'device.id가 필요합니다.');
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const retryAfter = pairRetryAfter(ip);
  if (retryAfter) {
    res.set('Retry-After', String(retryAfter));
    return err(res, 429, 'TOO_MANY_ATTEMPTS', '시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
  }
  const rec = state.pairingCodes.get(normalizeCode(pairingCode));
  if (!rec || rec.usedAt || rec.invalidatedAt || rec.expiresAt <= now()) {
    state.pairFailures.get(ip).push(Date.now());
    return err(res, 401, 'INVALID_PAIRING_CODE', '코드가 맞지 않거나 만료되었습니다. 새 QR을 띄워 주세요.');
  }
  if ((config.blockedDeviceIds || []).includes(device.id)) return err(res, 403, 'DEVICE_NOT_ALLOWED', '이 기기는 연결할 수 없습니다.');
  const user = USERS.find((u) => u.userMno === rec.userMno);
  rec.usedAt = now(); // 일회용 — 연결에 성공할 때만 소비한다
  const d = bindDevice(device, user);
  res.json({ ...issueToken(d), user: userView(user) });
});

api.post('/devices/refresh', auth, (req, res) => res.json(issueToken(req.device)));

api.get('/bootstrap', auth, (req, res) => res.json({
  user: userView(req.user),
  projects: PROJECTS,
  policy: { offlineGraceDays: config.offlineGraceDays, maxImageBytes: MAX_IMAGE_BYTES },
  serverTime: iso(now()),
}));

api.get('/notes', auth, (req, res) => {
  const notes = [...state.notes.values()].filter((n) => n.ownerMno === req.user.userMno
    && (n.createdByDevice === req.device.deviceId || ownsNote(req, n)));
  res.json({ notes: notes.map(noteView) });
});

api.post('/notes', auth, (req, res) => {
  const { clientNoteId, projectMno, title, deviceCreatedAt } = req.body || {};
  if (!clientNoteId || !title) return err(res, 400, 'BAD_REQUEST', 'clientNoteId와 title이 필요합니다.');
  const existing = [...state.notes.values()].find((n) => n.clientNoteId === clientNoteId);
  if (existing) return res.status(200).json(noteView(existing));
  const project = PROJECTS.find((p) => p.projectMno === projectMno);
  if (!project || !project.writable) return err(res, 403, 'PROJECT_NOT_WRITABLE', '이 프로젝트에는 노트를 만들 수 없습니다.');
  const note = { noteMno: ++state.seq.note, clientNoteId, projectMno, title, ownerMno: req.user.userMno,
    status: 'WRITING', editLocation: { type: 'DEVICE', deviceId: req.device.deviceId },
    createdByDevice: req.device.deviceId, deviceCreatedAt, createdAt: now(), updatedAt: now(), latestVersionId: null, versionIds: [], history: [] };
  state.notes.set(note.noteMno, note);
  res.status(201).json(noteView(note));
});

api.post('/notes/:noteMno/versions', auth, upload.any(), (req, res) => {
  const note = state.notes.get(Number(req.params.noteMno));
  if (!note) return err(res, 404, 'NOT_FOUND', '노트가 없습니다.');
  let meta;
  try { meta = JSON.parse(req.body.meta || '{}'); } catch { return err(res, 400, 'BAD_REQUEST', 'meta JSON 오류'); }
  const noteContent = String(req.body.noteContent ?? '');
  if (!meta.clientVersionId) return err(res, 400, 'BAD_REQUEST', 'clientVersionId가 필요합니다.');

  const dup = state.clientVersions.get(meta.clientVersionId);
  if (dup) {
    const v = state.versions.get(dup);
    return res.status(200).json({ versionId: v.versionId, receivedAt: iso(v.receivedAt), duplicate: true });
  }
  if (!ownsNote(req, note)) {
    return err(res, 409, 'NOT_EDIT_OWNER', '이 기기에 편집권이 없습니다.', { status: note.status, editLocation: note.editLocation });
  }
  if (note.status !== 'WRITING' && note.status !== 'REJECT') {
    return err(res, 409, 'NOT_WRITABLE', '점검 요청 이후에는 수정할 수 없습니다.', { status: note.status, editLocation: note.editLocation });
  }
  if ((meta.baseVersionId ?? null) !== note.latestVersionId) {
    return err(res, 409, 'STALE_BASE', '서버 최신 버전과 다릅니다.', { latestVersionId: note.latestVersionId });
  }

  const images = (req.files || []).map((f) => {
    const m = /^inlineImages\[(.+)\]$/.exec(f.fieldname);
    const src = m ? m[1] : '';
    return { src, ref: src.startsWith(BLOB_PREFIX) ? src.slice(BLOB_PREFIX.length) : src, buffer: f.buffer, mimetype: f.mimetype, originalname: f.originalname };
  });
  if (meta.contentHash !== contentHash(noteContent, images)) {
    return err(res, 422, 'HASH_MISMATCH', '전송 중 내용이 손상되었습니다.');
  }

  // ElnNoteEditorService.createNoteEditorDtl과 같은 규칙: blob: 이미지를 파일로 저장하고 경로 치환
  let html = noteContent;
  for (const img of images) {
    const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(img.originalname || '') || [, (img.mimetype || '').split('/')[1] || 'bin'])[1];
    const saveNm = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(IMAGE_DIR, saveNm), img.buffer);
    html = html.split(`src="${img.src}"`).join(`src="/editor-inline-images/${saveNm}?noteMno=${note.noteMno}"`);
  }

  const v = { versionId: ++state.seq.version, noteMno: note.noteMno, clientVersionId: meta.clientVersionId,
    html, source: 'APP', deviceId: req.device.deviceId, deviceWrittenAt: meta.deviceWrittenAt, receivedAt: now(),
    contentHash: meta.contentHash, autoSave: !!meta.autoSave, imageCount: images.length };
  state.versions.set(v.versionId, v);
  state.clientVersions.set(v.clientVersionId, v.versionId);
  note.versionIds.push(v.versionId);
  note.latestVersionId = v.versionId;
  if (typeof meta.title === 'string' && meta.title.trim()) note.title = meta.title.trim().slice(0, 200);
  note.updatedAt = now();
  res.status(201).json({ versionId: v.versionId, receivedAt: iso(v.receivedAt) });
});

api.post('/notes/:noteMno/release', auth, (req, res) => {
  const note = state.notes.get(Number(req.params.noteMno));
  if (!note) return err(res, 404, 'NOT_FOUND', '노트가 없습니다.');
  if (!ownsNote(req, note)) {
    return err(res, 409, 'NOT_EDIT_OWNER', '이 기기에 편집권이 없습니다.', { status: note.status, editLocation: note.editLocation });
  }
  if ((req.body?.lastVersionId ?? null) !== note.latestVersionId) {
    return err(res, 409, 'VERSION_MISMATCH', '아직 올라가지 않은 버전이 있습니다.', { latestVersionId: note.latestVersionId });
  }
  note.editLocation = { type: 'WEB' };
  note.history.push({ at: now(), event: 'RELEASED', by: req.device.deviceId });
  note.updatedAt = now();
  res.json({ status: note.status, editLocation: note.editLocation });
});

app.use('/api/app/v1', api);

// ── 테스트용 관리 ──
const admin = express.Router();
admin.get('/state', (_req, res) => res.json({
  config,
  devices: [...state.devices.values()].map(({ tokenHash, ...d }) => d),
  pairingCodes: [...state.pairingCodes.values()].map((c) => ({ code: c.code, userMno: c.userMno, createdAt: iso(c.createdAt),
    expiresAt: iso(c.expiresAt), usedAt: c.usedAt ? iso(c.usedAt) : null, invalidatedAt: c.invalidatedAt ? iso(c.invalidatedAt) : null })),
  notes: [...state.notes.values()].map((n) => ({ ...noteView(n), versionIds: n.versionIds, history: n.history })),
  versions: [...state.versions.values()].map(({ html, ...v }) => ({ ...v, htmlBytes: html.length,
    hasDrawing: /<figure[^>]*data-strokes/.test(html), inlineImagePaths: (html.match(/\/editor-inline-images\/[^"?]+/g) || []).length })),
}));
admin.post('/reset', (_req, res) => { reset(); config = defaultConfig(); res.json({ ok: true }); });
admin.post('/config', (req, res) => {
  const b = req.body || {};
  if (b.blockedDeviceIds !== undefined && !(Array.isArray(b.blockedDeviceIds) && b.blockedDeviceIds.every((x) => typeof x === 'string'))) {
    return err(res, 400, 'BAD_REQUEST', 'blockedDeviceIds는 문자열 배열이어야 합니다.');
  }
  for (const k of ['passwordLogin', 'appEnabled']) {
    if (b[k] !== undefined && typeof b[k] !== 'boolean') return err(res, 400, 'BAD_REQUEST', `${k}는 boolean이어야 합니다.`);
  }
  config = { ...config, ...b };
  res.json(config);
});
/** 구노 웹의 "QR 띄우기"(POST /api/eln/app/pairing-code) 대신. 새 코드를 만들면 그 사용자의 이전 미사용 코드는 무효. */
admin.post('/pairing-code', (req, res) => {
  const { loginId, ttlMs } = req.body || {};
  const user = USERS.find((u) => u.loginId === loginId);
  if (!user) return err(res, 404, 'NOT_FOUND', '사용자가 없습니다.');
  if (ttlMs !== undefined && !(Number.isFinite(ttlMs) && ttlMs > 0)) return err(res, 400, 'BAD_REQUEST', 'ttlMs는 양수여야 합니다.');
  for (const c of state.pairingCodes.values()) {
    if (c.userMno === user.userMno && !c.usedAt && !c.invalidatedAt) c.invalidatedAt = now();
  }
  let code;
  do {
    code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (state.pairingCodes.has(code));
  const expiresAt = new Date(Date.now() + (ttlMs ?? PAIRING_TTL_MS));
  state.pairingCodes.set(code, { code, userMno: user.userMno, createdAt: now(), expiresAt, usedAt: null, invalidatedAt: null });
  const server = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const qrPayload = `goono-note://pair?server=${encodeURIComponent(server)}&code=${encodeURIComponent(displayCode(code))}`;
  res.json({ code: displayCode(code), qrPayload, expiresAt: iso(expiresAt) });
});
admin.post('/notes/:noteMno/reclaim', (req, res) => {
  const note = state.notes.get(Number(req.params.noteMno));
  if (!note) return err(res, 404, 'NOT_FOUND', '노트가 없습니다.');
  note.editLocation = { type: 'WEB' };
  note.history.push({ at: now(), event: 'RECLAIMED', reason: req.body?.reason || '관리자 회수' });
  res.json(noteView(note));
});
admin.post('/notes/:noteMno/status', (req, res) => {
  const note = state.notes.get(Number(req.params.noteMno));
  if (!note) return err(res, 404, 'NOT_FOUND', '노트가 없습니다.');
  if (note.editLocation.type === 'DEVICE' && req.body?.status === 'INSPECTION') {
    return err(res, 409, 'EDITING_ON_DEVICE', '태블릿에서 작성 중인 노트는 점검 요청할 수 없습니다.');
  }
  note.status = req.body?.status || note.status;
  res.json(noteView(note));
});
admin.post('/devices/:deviceId/revoke', (req, res) => {
  // 본문에 userMno가 있으면 그 사용자의 묶음만, 없으면 이 기기 ID의 모든 묶음
  const found = [...state.devices.values()].filter((d) => d.deviceId === req.params.deviceId
    && (req.body?.userMno === undefined || d.userMno === req.body.userMno));
  if (!found.length) return err(res, 404, 'NOT_FOUND', '기기가 없습니다.');
  for (const d of found) d.revoked = true;
  res.json({ ok: true });
});
app.use('/__admin', admin);

// ── 구노 웹 대신 확인 화면 ──
app.use('/editor-inline-images', express.static(IMAGE_DIR));
app.get('/versions/:versionId', (req, res) => {
  const v = state.versions.get(Number(req.params.versionId));
  if (!v) return res.sendStatus(404);
  res.type('html').send(`<!doctype html><meta charset="utf-8"><body style="max-width:820px;margin:24px auto;font-family:sans-serif">${v.html}</body>`);
});
app.get('/', (_req, res) => {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = [...state.notes.values()].map((n) => {
    const devName = [...state.devices.values()].find((d) => d.deviceId === n.editLocation.deviceId && d.userMno === n.ownerMno)?.name;
    const loc = n.editLocation.type === 'DEVICE' ? `태블릿(${esc(devName)})에서 작성 중 · 웹 읽기 전용` : '웹';
    const vers = n.versionIds.map((id) => state.versions.get(id)).map((v) =>
      `<li><a href="/versions/${v.versionId}">버전 ${v.versionId}</a> · 서버 수신 ${esc(v.receivedAt.toISOString())} · 기기 작성 ${esc(v.deviceWrittenAt)} · 이미지 ${v.imageCount}${v.autoSave ? ' · 자동' : ''}</li>`).join('');
    return `<section style="border:1px solid #ccd;border-radius:8px;padding:12px;margin:12px 0"><b>${esc(n.title)}</b> <small>#${n.noteMno} · ${esc(n.status)} · 편집 위치: ${loc}</small><ul>${vers || '<li>버전 없음</li>'}</ul></section>`;
  }).join('');
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>구노 ELN (모의)</title><body style="max-width:900px;margin:24px auto;font-family:sans-serif"><h1>구노 ELN 모의 서버</h1><p>태블릿 앱이 올린 노트와 버전입니다.</p>${rows || '<p>아직 없습니다.</p>'}</body>`);
});

app.listen(PORT, () => console.log(`[mock-eln] http://localhost:${PORT}  (API: /api/app/v1, 계정 researcher1·researcher2 / goono1234, 연결 코드: POST /__admin/pairing-code)`));
