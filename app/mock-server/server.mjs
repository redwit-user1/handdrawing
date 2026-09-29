/**
 * 구노 ELN 동기화 API(v1) 모의 서버 — 앱 개발·E2E 테스트용.
 * 계약: ../docs/SYNC-API.md. 실제 구현은 Goono-ELN에 한다.
 *
 *   node mock-server/server.mjs            (기본 포트 8787)
 *   PORT=8787 OFFLINE_GRACE_DAYS=14 node mock-server/server.mjs
 *
 * 테스트 계정: researcher1 / goono1234
 * 확인 화면: http://localhost:8787/  (구노 웹 대신 받은 노트·버전을 보여준다)
 * 관리(테스트용): /__admin/* — 편집권 회수, 상태 변경, 기기 폐기, 토큰 기한 조정
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

const USERS = [{ userMno: 12, loginId: 'researcher1', password: 'goono1234', name: '김연구' }];
const PROJECTS = [
  { projectMno: 3, name: '시료 A 열처리', writable: true },
  { projectMno: 4, name: '세포 배양 조건 최적화', writable: true },
  { projectMno: 5, name: '2025 종료 과제 (읽기 전용)', writable: false },
];

let config = { offlineGraceDays: Number(process.env.OFFLINE_GRACE_DAYS || 14), tokenTtlMs: null };
let state;
function reset() {
  state = { devices: new Map(), notes: new Map(), versions: new Map(), clientVersions: new Map(), seq: { note: 100, version: 5000 } };
}
reset();

const now = () => new Date();
const iso = (d) => d.toISOString();
const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const err = (res, status, code, message, extra = {}) => res.status(status).json({ error: { code, message }, ...extra });

function issueToken(device) {
  const token = crypto.randomBytes(24).toString('base64url');
  const ttl = config.tokenTtlMs ?? config.offlineGraceDays * 86400_000;
  device.tokenHash = sha256hex(token);
  device.tokenExpiresAt = new Date(Date.now() + ttl);
  return { token, tokenExpiresAt: iso(device.tokenExpiresAt), offlineGraceDays: config.offlineGraceDays, serverTime: iso(now()) };
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
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '2mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, fieldSize: 60 * 1024 * 1024 } });

const api = express.Router();

api.post('/devices/register', (req, res) => {
  const { loginId, password, device } = req.body || {};
  const user = USERS.find((u) => u.loginId === loginId && u.password === password);
  if (!user) return err(res, 401, 'INVALID_CREDENTIALS', '아이디 또는 비밀번호가 올바르지 않습니다.');
  if (!device?.id) return err(res, 400, 'BAD_REQUEST', 'device.id가 필요합니다.');
  const d = state.devices.get(device.id) || { deviceId: device.id };
  Object.assign(d, { userMno: user.userMno, name: device.name, platform: device.platform, model: device.model,
    appVersion: device.appVersion, revoked: false, registeredAt: d.registeredAt || now(), lastSeenAt: now() });
  state.devices.set(device.id, d);
  res.json({ ...issueToken(d), user: { userMno: user.userMno, loginId: user.loginId, name: user.name } });
});

api.post('/devices/refresh', auth, (req, res) => res.json(issueToken(req.device)));

api.get('/bootstrap', auth, (req, res) => res.json({
  user: { userMno: req.user.userMno, loginId: req.user.loginId, name: req.user.name },
  projects: PROJECTS,
  policy: { offlineGraceDays: config.offlineGraceDays, maxImageBytes: MAX_IMAGE_BYTES },
  serverTime: iso(now()),
}));

api.get('/notes', auth, (req, res) => {
  const notes = [...state.notes.values()].filter((n) => n.createdByDevice === req.device.deviceId
    || (n.editLocation.type === 'DEVICE' && n.editLocation.deviceId === req.device.deviceId));
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
  if (note.editLocation.type !== 'DEVICE' || note.editLocation.deviceId !== req.device.deviceId) {
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
  note.updatedAt = now();
  res.status(201).json({ versionId: v.versionId, receivedAt: iso(v.receivedAt) });
});

api.post('/notes/:noteMno/release', auth, (req, res) => {
  const note = state.notes.get(Number(req.params.noteMno));
  if (!note) return err(res, 404, 'NOT_FOUND', '노트가 없습니다.');
  if (note.editLocation.type !== 'DEVICE' || note.editLocation.deviceId !== req.device.deviceId) {
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
  notes: [...state.notes.values()].map((n) => ({ ...noteView(n), versionIds: n.versionIds, history: n.history })),
  versions: [...state.versions.values()].map(({ html, ...v }) => ({ ...v, htmlBytes: html.length,
    hasDrawing: /<figure[^>]*data-strokes/.test(html), inlineImagePaths: (html.match(/\/editor-inline-images\/[^"?]+/g) || []).length })),
}));
admin.post('/reset', (_req, res) => { reset(); config = { offlineGraceDays: Number(process.env.OFFLINE_GRACE_DAYS || 14), tokenTtlMs: null }; res.json({ ok: true }); });
admin.post('/config', (req, res) => { config = { ...config, ...req.body }; res.json(config); });
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
  const d = state.devices.get(req.params.deviceId);
  if (!d) return err(res, 404, 'NOT_FOUND', '기기가 없습니다.');
  d.revoked = true;
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
    const loc = n.editLocation.type === 'DEVICE' ? `태블릿(${esc(state.devices.get(n.editLocation.deviceId)?.name)})에서 작성 중 · 웹 읽기 전용` : '웹';
    const vers = n.versionIds.map((id) => state.versions.get(id)).map((v) =>
      `<li><a href="/versions/${v.versionId}">버전 ${v.versionId}</a> · 서버 수신 ${esc(v.receivedAt.toISOString())} · 기기 작성 ${esc(v.deviceWrittenAt)} · 이미지 ${v.imageCount}${v.autoSave ? ' · 자동' : ''}</li>`).join('');
    return `<section style="border:1px solid #ccd;border-radius:8px;padding:12px;margin:12px 0"><b>${esc(n.title)}</b> <small>#${n.noteMno} · ${esc(n.status)} · 편집 위치: ${loc}</small><ul>${vers || '<li>버전 없음</li>'}</ul></section>`;
  }).join('');
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>구노 ELN (모의)</title><body style="max-width:900px;margin:24px auto;font-family:sans-serif"><h1>구노 ELN 모의 서버</h1><p>태블릿 앱이 올린 노트와 버전입니다.</p>${rows || '<p>아직 없습니다.</p>'}</body>`);
});

app.listen(PORT, () => console.log(`[mock-eln] http://localhost:${PORT}  (API: /api/app/v1, 계정 researcher1/goono1234)`));
