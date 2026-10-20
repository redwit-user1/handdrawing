/**
 * 구노 ELN 동기화 API(v1) 모의 서버 — 앱 개발·E2E 테스트용.
 * 계약: ../docs/SYNC-API.md. 실제 구현은 Goono-ELN에 한다.
 *
 *   node mock-server/server.mjs            (기본 포트 8787. PORT=0 이면 빈 포트를 골라 첫 줄 "[mock-eln] http://localhost:<port>" 로 알린다)
 *   PORT=8787 OFFLINE_GRACE_DAYS=14 node mock-server/server.mjs
 *   PUBLIC_URL=https://eln.example.com     (QR 내용에 넣을 서버 주소. 기본은 요청의 Host)
 *
 * 테스트 계정: researcher1 / goono1234 (userMno 12), researcher2 / goono1234 (userMno 13)
 * 과제 구성원: researcher1 → 3·4·5, researcher2 → 3·4 (과제 5는 편집 불가 — 연결하면 SUSPENDED)
 * 연결(과제 QR): POST /__admin/pairing-code {loginId, projectMno, ttlMs?} 로 과제 연결 코드·QR 내용을 받고(책임자의 "QR 만들기" 대신),
 *           앱은 /devices/pair/preview → /devices/pair(202 승인 대기) → /devices/pair/status 로 연결한다.
 *           연구원의 구노 웹 승인은 POST /__admin/approve {loginId, decision?} 로 흉내 낸다.
 *           (비밀번호 /devices/register 는 보조 경로 — 토큰만, 과제 연결 없음. 기본 꺼짐, POST /__admin/config {"passwordLogin":true})
 * 확인 화면: http://localhost:8787/  (구노 웹 대신 받은 노트·버전을 보여준다)
 * 관리(테스트용): /__admin/* — 과제 QR 발급, 승인·거절, 연결 끊기, 과제 상태·구성원, 마지막 접속, 하루 1번 작업,
 *                 편집권 회수, 노트 상태, 기기 사용 중지, 저장 이미지 기록 지우기, 설정
 */
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787); // '0' 도 그대로 0(빈 포트)
const IMAGE_DIR = process.env.IMAGE_DIR || path.join(here, '.data', 'editor-inline-images');
const BLOB_PREFIX = 'blob:goono-app/';
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

fs.mkdirSync(IMAGE_DIR, { recursive: true });

const USERS = [
  { userMno: 12, loginId: 'researcher1', password: 'goono1234', name: '김연구' },
  { userMno: 13, loginId: 'researcher2', password: 'goono1234', name: '이연구' },
];
/**
 * 과제. editable = 삭제·미사용 아님 + 진행 상태·유예로 편집 가능(서버 ElnProjectGracePeriodPolicy). members = 구성원 userMno,
 * leaders = 과제 책임자(PJ_MANAGER·PJ_LEAD_RESEARCHER 또는 총괄) userMno — 모의 서버에서는 researcher1 이 세 과제의 책임자다.
 */
const seedProjects = () => [
  { projectMno: 3, name: '시료 A 열처리', editable: true, members: [12, 13], leaders: [12] },
  { projectMno: 4, name: '세포 배양 조건 최적화', editable: true, members: [12, 13], leaders: [12] },
  { projectMno: 5, name: '2025 종료 과제 (읽기 전용)', editable: false, members: [12], leaders: [12] },
];

// 연결 코드: 8자, 0·O·1·I·L 제외. 저장·비교는 대문자로 바꾸고 '-'·공백을 지운 값.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;
const PAIRING_TTL_MS = 5 * 60_000; // 과제 QR 5분
const REQUEST_TTL_MS = 10 * 60_000; // 승인 요청 10분
const DELIVERY_TTL_MS = 10 * 60_000; // 승인 뒤 토큰 수령 기한(승인 시각 + 10분)
const INACTIVE_DAYS = 30; // 장기 미접속
const DAY_MS = 86_400_000;
const FAIL_LIMIT = 5; // 같은 IP에서
const FAIL_WINDOW_MS = 10 * 60_000; // 10분 안에
const PREV_TOKEN_GRACE_MS = 10 * 60_000; // 토큰 갱신 뒤 이전 토큰을 받아 주는 시간(계약 §2)
const MAX_TITLE_LENGTH = 256; // 노트 제목(글자 수)
const MAX_UPLOAD_BYTES = MAX_IMAGE_BYTES; // 버전 1건 전송 바이트(meta + noteContent + 이미지) 상한 — 서버 app.device.max-upload-bytes
const REF_PATTERN = /^[A-Za-z0-9-]{16,64}$/;
const BODY_REF_PATTERN = /blob:goono-app\/([A-Za-z0-9-]*)/g; // 본문의 이미지 ref(계약 §6 — 가장 길게)
const SYSTEM_ACTOR = 0; // 시스템 작업의 이력 작성자
/** 끊김 사유 → 노트 이력(NOTE_EDIT_RECLAIM) 내용 */
const END_REASON_TEXT = {
  LEADER: '연결 끊김', MEMBER_REMOVED: '구성원 제외', REVOKED: '기기 사용 중지', HANDOVER: '다른 연구원이 기기 연결', INACTIVE: '장기 미접속',
};
const SUSPEND_HISTORY_TEXT = '과제 종료';
/** 서버 DDL(PL_APP_DEVICE) 길이: [필드, 필수, 최대 길이] */
const DEVICE_RULES = [['id', true, 64], ['name', true, 100], ['platform', true, 20], ['model', false, 100], ['appVersion', false, 30]];
const validDevice = (d) => !!d && typeof d === 'object' && DEVICE_RULES.every(([k, required, max]) => {
  const v = d[k];
  if (v === undefined || v === null) return !required;
  return typeof v === 'string' && v.length <= max && (!required || v.trim() !== '');
});
/** 서버와 같은 제목 다듬기: 앞뒤 공백 제거, 비면 "제목 없음", 256자(코드 포인트)에서 자름 */
const normalizeTitle = (t) => {
  const s = typeof t === 'string' ? t.trim() : '';
  return s ? [...s].slice(0, MAX_TITLE_LENGTH).join('') : '제목 없음';
};
const normalizeCode = (s) => String(s ?? '').toUpperCase().replace(/[-\s]/g, '');
const displayCode = (norm) => `${norm.slice(0, 4)}-${norm.slice(4)}`;
const deviceKey = (deviceId, userMno) => `${deviceId}:${userMno}`;
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

const defaultConfig = () => ({
  offlineGraceDays: Number(process.env.OFFLINE_GRACE_DAYS || 14),
  tokenTtlMs: null,
  requestTtlMs: null, // 승인 요청 유효 시간(기본 10분) — 시험용으로 줄인다
  deliveryTtlMs: null, // 승인 뒤 토큰 수령 기한(기본 승인 + 10분) — 시험용으로 줄인다
  passwordLogin: false, // 서버 설정 app.device.password-login.enabled — 기본 꺼짐(QR 연결만). 개발 중 비밀번호 화면을 쓰려면 /__admin/config 로 켠다
  appEnabled: true, // 기관이 태블릿 연결을 켰는가
  blockedDeviceIds: [],
});
let config = defaultConfig();
let state;
function reset() {
  state = {
    projects: seedProjects(),
    devices: new Map(), // key: `${deviceId}:${userMno}` — 기기 묶음(PL_APP_DEVICE 한 행)
    links: new Map(), // key: linkMno — 과제 연결(PL_APP_PROJECT_LINK), (deviceMno, projectMno) 유일
    requests: new Map(), // key: requestMno — 승인 요청(PL_APP_PAIRING_REQUEST)
    notes: new Map(), versions: new Map(), clientVersions: new Map(),
    seq: { note: 100, version: 5000, device: 900, link: 0, request: 0 },
    pairingCodes: new Map(), // key: 정규화된 코드
    pairFailures: new Map(), // key: IP → 실패 시각(ms) 목록 (preview·pair·register 공유)
  };
}
reset();

const now = () => new Date();
const iso = (d) => (d ? d.toISOString() : null);
const secondsLeft = (d) => Math.max(0, Math.ceil((d - Date.now()) / 1000));
const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const err = (res, status, code, message) => res.status(status).json({ error: { code, message } });
const userView = (u) => ({ userMno: u.userMno, loginId: u.loginId, name: u.name });
const userOf = (userMno) => USERS.find((u) => u.userMno === userMno);
const projectOf = (projectMno) => state.projects.find((p) => p.projectMno === projectMno);
const isMember = (project, userMno) => !!project && project.members.includes(userMno);
const deviceByMno = (deviceMno) => [...state.devices.values()].find((d) => d.deviceMno === deviceMno);
const linksOf = (device) => [...state.links.values()].filter((l) => l.deviceMno === device.deviceMno);
const linkFor = (device, projectMno) => linksOf(device).find((l) => l.projectMno === projectMno);
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.projectMno - b.projectMno);

/**
 * 요청 시점의 연결 상태(서버 AppLinkRules.effectiveStatus): 끊김이거나 구성원이 아니면 ENDED, 과제가 편집 불가면 SUSPENDED,
 * 아니면 ACTIVE. 하루 작업 전이라도 과제·구성원 상태로 바로 판정한다(저장된 SUSPENDED 라도 다시 편집 가능하면 ACTIVE).
 */
function effectiveStatus(link) {
  const device = deviceByMno(link.deviceMno);
  const project = projectOf(link.projectMno);
  if (link.status === 'ENDED' || !isMember(project, device.userMno)) return 'ENDED';
  if (!project.editable) return 'SUSPENDED';
  return 'ACTIVE';
}

/** 살아 있는 연결 = 요청 때 상태(effectiveStatus)가 ACTIVE·SUSPENDED 인 연결(저장 상태가 아니다) */
const liveLinksOf = (device) => linksOf(device).filter((l) => effectiveStatus(l) !== 'ENDED');

/**
 * 새 토큰 발급. presentedHash 는 갱신(/devices/refresh)일 때 요청이 보낸 토큰의 해시 — 현재 토큰이면 그것을 10분 동안 이전 토큰으로
 * 남기고, 유예 중인 이전 토큰이면(응답을 못 받은 재시도) 이전 토큰·유예 기한은 그대로 둔다. 연결(승인 수령·register)은 이전 토큰을 지운다.
 */
function issueToken(device, presentedHash) {
  const token = crypto.randomBytes(24).toString('base64url');
  const ttl = config.tokenTtlMs ?? config.offlineGraceDays * DAY_MS;
  if (presentedHash === undefined) {
    device.prevTokenHash = null;
    device.prevValidUntil = null;
  } else if (presentedHash === device.tokenHash) {
    device.prevTokenHash = presentedHash;
    device.prevValidUntil = new Date(Date.now() + PREV_TOKEN_GRACE_MS);
  }
  device.tokenHash = sha256hex(token);
  device.tokenExpiresAt = new Date(Date.now() + ttl);
  return { token, tokenExpiresAt: iso(device.tokenExpiresAt), offlineGraceDays: config.offlineGraceDays, serverTime: iso(now()) };
}

/**
 * 기기 묶음은 (기기 ID, 사용자) 단위. 없으면 토큰 없는 새 묶음을 만들고, 있으면 이름·플랫폼·모델·앱 버전만 바꾼다
 * (사용 중지·토큰은 건드리지 않는다 — 서버 upsertDeviceOnApprove. 사용 중지는 토큰을 새로 줄 때만 풀린다).
 */
function upsertDevice(info, userMno) {
  const key = deviceKey(info.id, userMno);
  let d = state.devices.get(key);
  if (!d) {
    d = { deviceMno: ++state.seq.device, deviceId: info.id, userMno, revoked: false, revokedAt: null, tokenHash: null, tokenExpiresAt: null,
      prevTokenHash: null, prevValidUntil: null, registeredAt: now(), lastSeenAt: null };
    state.devices.set(key, d);
  }
  Object.assign(d, { name: info.name, platform: info.platform, model: info.model ?? null, appVersion: info.appVersion ?? null });
  return d;
}
/**
 * 토큰을 새로 주면서 사용 중지를 풀고 마지막 접속을 지금으로(서버 issueToken — 오래 쉰 묶음을 다시 연결해도 다음 하루 작업이
 * 장기 미접속으로 끊지 않게).
 */
function deliverToken(device) {
  device.revoked = false;
  device.revokedAt = null;
  device.lastSeenAt = now();
  return issueToken(device);
}

/** 현재 토큰, 없으면 이전 토큰(갱신 재시도 유예 — 사용 중지된 기기는 유예와 관계없이 찾아 DEVICE_REVOKED 로 알린다) */
function deviceByToken(hash) {
  const devices = [...state.devices.values()];
  const current = devices.find((d) => d.tokenHash === hash);
  if (current) return { device: current, current: true };
  const prev = devices.find((d) => d.prevTokenHash === hash);
  if (prev && (prev.revoked || (prev.prevValidUntil && prev.prevValidUntil > now()))) return { device: prev, current: false };
  return null;
}
const bearerHash = (req) => {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  return m ? sha256hex(m[1]) : null;
};

function auth(req, res, next) {
  const hash = bearerHash(req);
  if (!hash) return err(res, 401, 'UNAUTHORIZED', '기기 토큰이 필요합니다.');
  const found = deviceByToken(hash);
  if (!found) return err(res, 401, 'UNAUTHORIZED', '알 수 없는 토큰입니다.');
  const { device, current } = found;
  if (device.revoked) return err(res, 401, 'DEVICE_REVOKED', '이 기기는 사용이 중지되었습니다.');
  if (device.tokenExpiresAt < now()) return err(res, 401, 'TOKEN_EXPIRED', '다시 연결하세요.');
  if (current && device.prevTokenHash) { device.prevTokenHash = null; device.prevValidUntil = null; } // 새 토큰의 첫 요청
  device.lastSeenAt = now();
  req.device = device;
  req.tokenHash = hash;
  req.user = userOf(device.userMno);
  next();
}

/** 이 기기 묶음의 그 과제 연결이 활성인지(서버 requireActiveLink). 아니면 403 을 보내고 true */
function linkBlocked(req, res, projectMno) {
  const link = linkFor(req.device, projectMno);
  const status = link ? effectiveStatus(link) : 'ENDED';
  if (status === 'ENDED') return !!err(res, 403, 'PROJECT_NOT_LINKED', '이 과제는 이 기기에 연결되어 있지 않습니다.');
  if (status === 'SUSPENDED') return !!err(res, 403, 'PROJECT_SUSPENDED', '과제가 종료되어 이 과제의 태블릿 작성이 중지되었습니다.');
  return false;
}

/** 편집 위치가 이 기기·이 사용자인 노트인가 (같은 기기를 다른 사용자가 연결해도 남의 노트를 건드리지 못한다) */
const ownsNote = (req, note) => note.editLocation.type === 'DEVICE'
  && note.editLocation.deviceId === req.device.deviceId && note.ownerMno === req.user.userMno;

/** 이 기기 묶음이 편집 위치인 노트(projectMno 가 null 이면 모든 과제)를 WEB 으로 되돌리고 이력(NOTE_EDIT_RECLAIM)을 남긴다 */
function returnNotesToWeb(device, projectMno, reasonText, actorMno) {
  let count = 0;
  for (const n of state.notes.values()) {
    if (n.ownerMno !== device.userMno || n.editLocation.type !== 'DEVICE' || n.editLocation.deviceId !== device.deviceId) continue;
    if (projectMno != null && n.projectMno !== projectMno) continue;
    n.editLocation = { type: 'WEB' };
    n.history.push({ at: now(), event: 'RECLAIMED', reason: reasonText, deviceMno: device.deviceMno, by: actorMno });
    n.updatedAt = now();
    count++;
  }
  return count;
}
/** 연결 하나를 끊는다(ENDED 가 아닐 때만 — 아니면 0). withNotes 면 그 과제의 노트도 WEB 으로 */
function endLink(link, reason, actorMno, withNotes = true) {
  if (link.status === 'ENDED') return 0;
  Object.assign(link, { status: 'ENDED', endReason: reason, endedAt: now(), endedBy: actorMno });
  if (withNotes) returnNotesToWeb(deviceByMno(link.deviceMno), link.projectMno, END_REASON_TEXT[reason], actorMno);
  return 1;
}
/** 기기 묶음의 살아 있는 연결을 모두 끊고, 그 묶음이 편집 위치인 노트를 모두 WEB 으로(서버 endAllLinks) */
function endAllLinks(device, reason, actorMno) {
  let ended = 0;
  for (const l of linksOf(device)) ended += endLink(l, reason, actorMno, false);
  returnNotesToWeb(device, null, END_REASON_TEXT[reason], actorMno);
  return ended;
}
function upsertLink(device, projectMno, issuerMno) {
  const link = linkFor(device, projectMno) || { linkMno: ++state.seq.link, deviceMno: device.deviceMno, projectMno };
  Object.assign(link, { status: 'ACTIVE', endReason: null, endedAt: null, endedBy: null, suspendedAt: null, linkedAt: now(),
    issuerMno: issuerMno ?? null });
  state.links.set(link.linkMno, link);
  return link;
}

// ── 승인 요청 ──
/** 지금 결과(서버 AppLinkRules.pollOutcome): PENDING | APPROVED | REJECTED | EXPIRED */
function pollOutcome(r) {
  if (r.status === 'PENDING') return r.expiresAt > now() ? 'PENDING' : 'EXPIRED';
  if (r.status === 'APPROVED') return r.decidedAt.getTime() + (config.deliveryTtlMs ?? DELIVERY_TTL_MS) > Date.now() ? 'APPROVED' : 'EXPIRED';
  if (r.status === 'REJECTED') return 'REJECTED';
  return 'EXPIRED'; // EXPIRED · CANCELED
}
/** 저장 상태(기한 지난 PENDING 은 EXPIRED 로 본다) */
const requestStatus = (r) => (r.status === 'PENDING' && r.expiresAt <= now() ? 'EXPIRED' : r.status);
const livePending = (r) => r.status === 'PENDING' && r.expiresAt > now();
/** 확인 번호(계약 §0.7): REQUEST_TOKEN_HASH(소문자 hex) 앞 8자를 부호 없는 정수로 읽어 10000 으로 나눈 나머지, 4자리(앞 0 채움) */
const confirmNumber = (r) => String(parseInt(r.tokenHash.slice(0, 8), 16) % 10000).padStart(4, '0');
function createRequest(fields) {
  const requestToken = crypto.randomBytes(24).toString('base64url');
  const r = { requestMno: ++state.seq.request, issuerMno: null, projectMno: null, deviceMno: null, ...fields,
    tokenHash: sha256hex(requestToken), status: 'PENDING', expiresAt: new Date(Date.now() + (config.requestTtlMs ?? REQUEST_TTL_MS)),
    decidedAt: null, createdAt: now() };
  state.requests.set(r.requestMno, r);
  return { status: 'PENDING', requestToken, expiresAt: iso(r.expiresAt), expiresInSeconds: secondsLeft(r.expiresAt), confirmNumber: confirmNumber(r) };
}
function cancelPending(match) {
  for (const r of state.requests.values()) {
    if (livePending(r) && match(r)) { r.status = 'CANCELED'; r.decidedAt = now(); }
  }
}
/**
 * 사용 중지 때 그 기기 묶음(기기 ID, 연구원)의 진행 중 요청을 CANCELED 로 — 기한 안 PENDING 과 수령 기한 안 APPROVED(이미 한 번
 * 받아 간 것 포함). 그 뒤 상태 확인은 410 이라, 도둑의 재인증·잘못 승인한 요청으로 토큰을 받아 사용 중지를 풀 수 없다.
 */
function cancelBundleRequests(device) {
  for (const r of state.requests.values()) {
    if (r.deviceId !== device.deviceId || r.userMno !== device.userMno) continue;
    if (livePending(r) || pollOutcome(r) === 'APPROVED') { r.status = 'CANCELED'; r.decidedAt = now(); }
  }
}
/** 구노 웹 승인·거절(서버 decideRequest). 연구원 본인의 PENDING·기한 안 요청만. */
function decideRequest(r, approve) {
  if (!approve) {
    r.status = 'REJECTED';
    r.decidedAt = now();
    return { status: 'REJECTED' };
  }
  if (r.kind === 'LINK') {
    if (!isMember(projectOf(r.projectMno), r.userMno)) return { error: [409, 'NOT_MEMBER', '과제 구성원이 아니어서 연결할 수 없습니다.'] };
    const device = upsertDevice({ id: r.deviceId, name: r.deviceNm, platform: r.platform, model: r.model, appVersion: r.appVersion }, r.userMno);
    upsertLink(device, r.projectMno, r.issuerMno);
    r.deviceMno = device.deviceMno;
    // 같은 기기를 다른 연구원이 연결 → 이전 연구원 묶음의 살아 있는 연결을 모두 끊고 노트를 WEB 으로
    for (const other of state.devices.values()) {
      if (other.deviceId === r.deviceId && other.userMno !== r.userMno && liveLinksOf(other).length) {
        endAllLinks(other, 'HANDOVER', r.userMno);
      }
    }
  }
  r.status = 'APPROVED';
  r.decidedAt = now();
  return { status: 'APPROVED' };
}

const noteView = (n) => ({
  noteMno: n.noteMno, clientNoteId: n.clientNoteId, title: n.title, projectMno: n.projectMno,
  status: n.status, editLocation: n.editLocation, latestVersionId: n.latestVersionId, updatedAt: iso(n.updatedAt),
});

/** 앱과 같은 규칙의 내용 해시(업로드 + 재사용 이미지) */
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

// 연결 실패 제한 — /devices/pair/preview·/devices/pair·/devices/register 가 IP별 실패 횟수를 공유한다(5회/10분)
const clientIp = (req) => req.ip || req.socket.remoteAddress || 'unknown';
/** 막혀 있으면 429 + Retry-After(풀릴 때까지 남은 초)를 보내고 true */
function rateLimited(req, res) {
  const ip = clientIp(req);
  const cutoff = Date.now() - FAIL_WINDOW_MS;
  const fails = (state.pairFailures.get(ip) || []).filter((t) => t > cutoff);
  state.pairFailures.set(ip, fails);
  if (fails.length < FAIL_LIMIT) return false;
  res.set('Retry-After', String(Math.max(1, Math.ceil((fails[0] + FAIL_WINDOW_MS - Date.now()) / 1000))));
  err(res, 429, 'TOO_MANY_ATTEMPTS', '시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
  return true;
}
const failed = (req, res) => { state.pairFailures.get(clientIp(req)).push(Date.now()); return res; };
// 성공해도 실패 횟수는 지우지 않는다(계약 §0). 실패는 10분 창에서 저절로 빠진다.
const invalidCode = (req, res) => failed(req, err(res, 401, 'INVALID_PAIRING_CODE', '코드가 맞지 않거나 만료되었습니다. 연구책임자에게 새 QR을 요청하세요.'));
/** 쓸 수 있는 과제 코드(미사용·무효 아님·기한 안) */
function validCode(raw) {
  const rec = state.pairingCodes.get(normalizeCode(raw));
  return rec && !rec.usedAt && !rec.invalidatedAt && rec.expiresAt > now() ? rec : null;
}
const projectRef = (p) => ({ projectMno: p.projectMno, name: p.name });

// 보조 경로 — 서버 설정(app.device.password-login.enabled)이 켜졌을 때만. 토큰만 주고 과제 연결은 만들지 않는다.
api.post('/devices/register', (req, res) => {
  if (config.passwordLogin === false) return err(res, 403, 'PASSWORD_LOGIN_DISABLED', '비밀번호 로그인은 사용할 수 없습니다. QR로 연결하세요.');
  const { loginId, password, device } = req.body || {};
  if (!loginId || !password || !validDevice(device)) return err(res, 400, 'BAD_REQUEST', 'loginId, password, device 가 필요합니다.');
  if (rateLimited(req, res)) return;
  const user = USERS.find((u) => u.loginId === loginId && u.password === password);
  if (!user) return failed(req, err(res, 401, 'INVALID_CREDENTIALS', '아이디 또는 비밀번호가 올바르지 않습니다.'));
  if ((config.blockedDeviceIds || []).includes(device.id)) return err(res, 403, 'DEVICE_NOT_ALLOWED', '이 기기는 연결할 수 없습니다.');
  // 사용 중지를 풀거나 과제 연결을 되살리는 길이 아니다 — 그건 과제 QR + 승인, 재인증 + 승인으로만
  const existing = state.devices.get(deviceKey(device.id, user.userMno));
  if (existing?.revoked) return err(res, 401, 'DEVICE_REVOKED', '이 기기는 사용이 중지되었습니다. 과제 QR로 다시 연결하세요.');
  if (existing && liveLinksOf(existing).length) {
    return err(res, 409, 'DEVICE_ALREADY_LINKED', '이 기기는 과제에 연결되어 있습니다. 다시 연결(재인증)을 쓰세요.');
  }
  const d = upsertDevice(device, user.userMno);
  res.json({ ...deliverToken(d), user: userView(user) });
});

// 과제 QR 미리보기 — 익명. 코드를 쓰지 않고 과제·연구원 이름만 알려 준다(실패는 연결과 같은 IP 실패 횟수).
api.post('/devices/pair/preview', (req, res) => {
  if (!isPlainObject(req.body)) return err(res, 400, 'BAD_REQUEST', '요청 본문 { pairingCode } 가 필요합니다.');
  if (rateLimited(req, res)) return;
  const rec = validCode(req.body.pairingCode);
  if (!rec) return invalidCode(req, res);
  res.json({ project: projectRef(projectOf(rec.projectMno)), user: userView(userOf(rec.userMno)), expiresAt: iso(rec.expiresAt) });
});

// 과제 QR 연결 요청 — 익명. 코드를 쓰고 승인 요청을 만든다(202). 토큰은 구노 웹 승인 뒤 /devices/pair/status 로 받는다.
api.post('/devices/pair', (req, res) => {
  const { pairingCode, device } = req.body || {};
  if (!validDevice(device)) return err(res, 400, 'BAD_REQUEST', '기기 정보(device)가 올바르지 않습니다.');
  if (rateLimited(req, res)) return;
  const rec = validCode(pairingCode);
  if (!rec) return invalidCode(req, res);
  if ((config.blockedDeviceIds || []).includes(device.id)) return err(res, 403, 'DEVICE_NOT_ALLOWED', '이 기기는 연결할 수 없습니다.');
  rec.usedAt = now(); // 일회용 — 요청을 만들 때 소비한다
  cancelPending((r) => r.kind === 'LINK' && r.deviceId === device.id && r.userMno === rec.userMno && r.projectMno === rec.projectMno);
  const pending = createRequest({ kind: 'LINK', userMno: rec.userMno, projectMno: rec.projectMno, issuerMno: rec.issuerMno,
    deviceId: device.id, deviceNm: device.name, platform: device.platform, model: device.model ?? null, appVersion: device.appVersion ?? null });
  res.status(202).json({ ...pending, project: projectRef(projectOf(rec.projectMno)), user: userView(userOf(rec.userMno)) });
});

/** 본문 { requestToken } 으로 요청을 찾는다. 없으면 400/401 을 보내고 null */
function requestOf(req, res) {
  const t = req.body?.requestToken;
  if (typeof t !== 'string' || !t) { err(res, 400, 'BAD_REQUEST', '요청 본문 { requestToken } 이 필요합니다.'); return null; }
  const hash = sha256hex(t);
  const r = [...state.requests.values()].find((x) => x.tokenHash === hash);
  if (!r) { err(res, 401, 'UNAUTHORIZED', '알 수 없는 연결 요청입니다.'); return null; }
  return r;
}

// 승인 상태 확인 — 익명(요청 토큰이 자격). 승인되면 수령 기한(승인 + 10분) 안의 확인마다 새 토큰.
api.post('/devices/pair/status', (req, res) => {
  const r = requestOf(req, res);
  if (!r) return;
  const outcome = pollOutcome(r);
  if (outcome === 'PENDING') return res.json({ status: 'PENDING', expiresAt: iso(r.expiresAt), expiresInSeconds: secondsLeft(r.expiresAt) });
  if (outcome === 'REJECTED') return err(res, 403, 'PAIRING_REJECTED', '구노 웹에서 연결을 거절했습니다.');
  if (outcome === 'EXPIRED') return err(res, 410, 'PAIRING_EXPIRED', '승인 시간이 지났습니다.');
  const device = state.devices.get(deviceKey(r.deviceId, r.userMno));
  res.json({ status: 'APPROVED', ...deliverToken(device), user: userView(userOf(r.userMno)) });
});

// 요청 취소 — 익명. 승인 대기 중이면 CANCELED, 이미 결정된 요청은 바꾸지 않고 그 상태를 알려 준다.
api.post('/devices/pair/cancel', (req, res) => {
  const r = requestOf(req, res);
  if (!r) return;
  if (livePending(r)) { r.status = 'CANCELED'; r.decidedAt = now(); }
  res.json({ status: requestStatus(r) });
});

// 재인증 — 기한 지난 토큰도 받는다. 살아 있는 과제 연결을 그대로 쓰도록 연구원 본인의 웹 승인을 요청한다.
api.post('/devices/reauth', (req, res) => {
  const hash = bearerHash(req);
  const found = hash && deviceByToken(hash);
  if (!found) return err(res, 401, 'UNAUTHORIZED', '알 수 없는 토큰입니다.');
  const { device } = found;
  if (device.revoked) return err(res, 401, 'DEVICE_REVOKED', '이 기기는 사용이 중지되었습니다.');
  const live = liveLinksOf(device);
  if (!live.length) return err(res, 403, 'NO_PROJECT_LINKS', '연결된 과제가 없습니다. 연구책임자에게 과제 QR을 요청하세요.');
  cancelPending((r) => r.kind === 'REAUTH' && r.deviceMno === device.deviceMno);
  const pending = createRequest({ kind: 'REAUTH', userMno: device.userMno, deviceMno: device.deviceMno, deviceId: device.deviceId,
    deviceNm: device.name, platform: device.platform, model: device.model, appVersion: device.appVersion });
  res.status(202).json({ ...pending, user: userView(userOf(device.userMno)),
    projects: live.map((l) => projectRef(projectOf(l.projectMno))).sort(byName) });
});

api.post('/devices/refresh', auth, (req, res) => res.json(issueToken(req.device, req.tokenHash)));

api.get('/bootstrap', auth, (req, res) => res.json({
  user: userView(req.user),
  // 이 기기 묶음의 연결 과제만(끊긴 것 포함), 이름순
  projects: linksOf(req.device).map((l) => {
    const linkStatus = effectiveStatus(l);
    return { ...projectRef(projectOf(l.projectMno)), writable: linkStatus === 'ACTIVE', linkStatus };
  }).sort(byName),
  policy: { offlineGraceDays: config.offlineGraceDays, maxImageBytes: MAX_IMAGE_BYTES },
  serverTime: iso(now()),
}));

api.get('/notes', auth, (req, res) => {
  const notes = [...state.notes.values()].filter((n) => n.ownerMno === req.user.userMno
    && (n.createdByDevice === req.device.deviceId || ownsNote(req, n)));
  res.json({ notes: notes.map(noteView) });
});

api.post('/notes', auth, (req, res) => {
  const { clientNoteId, projectMno, title } = req.body || {}; // deviceCreatedAt 은 받기만 하고 저장하지 않는다(서버와 같음)
  if (typeof clientNoteId !== 'string' || !clientNoteId.trim() || clientNoteId.length > 64 || projectMno == null) {
    return err(res, 400, 'BAD_REQUEST', 'clientNoteId(64자 이하)와 projectMno 가 필요합니다.');
  }
  // 멱등은 노트 주인 단위 — 다른 사용자의 같은 clientNoteId 와는 겹쳐도 된다. 기존 노트면 연결 검사보다 먼저 200
  const existing = [...state.notes.values()].find((n) => n.ownerMno === req.user.userMno && n.clientNoteId === clientNoteId);
  if (existing) return res.status(200).json(noteView(existing));
  if (linkBlocked(req, res, projectMno)) return;
  const project = projectOf(projectMno);
  if (!project || !project.editable || !isMember(project, req.user.userMno)) {
    return err(res, 403, 'PROJECT_NOT_WRITABLE', '이 프로젝트에는 노트를 만들 수 없습니다.');
  }
  const note = { noteMno: ++state.seq.note, clientNoteId, projectMno, title: normalizeTitle(title), ownerMno: req.user.userMno,
    status: 'WRITING', editLocation: { type: 'DEVICE', deviceId: req.device.deviceId },
    createdByDevice: req.device.deviceId, createdAt: now(), updatedAt: now(), latestVersionId: null, versionIds: [], history: [],
    images: {} }; // 저장 이미지 기록: ref → { sha256, saveNm }
  state.notes.set(note.noteMno, note);
  res.status(201).json(noteView(note));
});

api.post('/notes/:noteMno/versions', auth, upload.any(), (req, res) => {
  // 평가 순서는 서버와 같다(계약 §6). 409 본문은 { error } 뿐.
  // 1. multipart 가 아님
  if (!req.is('multipart/form-data')) return err(res, 400, 'BAD_REQUEST', 'multipart/form-data 요청이어야 합니다.');
  // 2. 남의 노트는 있는지도 알려 주지 않는다(404). 409 NOT_EDIT_OWNER 는 내 노트인데 편집 위치가 이 묶음이 아닐 때
  const note = state.notes.get(Number(req.params.noteMno));
  if (!note || note.ownerMno !== req.user.userMno) return err(res, 404, 'NOT_FOUND', '노트가 없습니다.');
  // 3. meta·noteContent 형식
  let meta;
  try { meta = JSON.parse(req.body.meta ?? ''); } catch { return err(res, 400, 'BAD_REQUEST', 'meta 가 JSON 이 아닙니다.'); }
  if (!isPlainObject(meta)) return err(res, 400, 'BAD_REQUEST', 'meta 가 JSON 객체가 아닙니다.');
  if (typeof meta.clientVersionId !== 'string' || !meta.clientVersionId.trim() || meta.clientVersionId.length > 64) {
    return err(res, 400, 'BAD_REQUEST', 'clientVersionId(64자 이하)가 필요합니다.');
  }
  if (meta.baseVersionId != null && !Number.isInteger(meta.baseVersionId)) return err(res, 400, 'BAD_REQUEST', 'baseVersionId 는 정수이거나 null 이어야 합니다.');
  if (typeof meta.contentHash !== 'string' || !meta.contentHash.trim()) return err(res, 400, 'BAD_REQUEST', 'contentHash 가 필요합니다.');
  const reusedRefs = meta.reusedRefs ?? [];
  if (!Array.isArray(reusedRefs) || reusedRefs.some((r) => typeof r !== 'string')) {
    return err(res, 400, 'BAD_REQUEST', 'reusedRefs 는 문자열 배열이어야 합니다.');
  }
  if (req.body.noteContent === undefined) return err(res, 400, 'BAD_REQUEST', 'noteContent 가 필요합니다.');
  const noteContent = String(req.body.noteContent);

  // 4. 같은 clientVersionId
  const dup = state.clientVersions.get(meta.clientVersionId);
  if (dup) {
    const v = state.versions.get(dup);
    if (v.noteMno !== note.noteMno) return err(res, 400, 'BAD_REQUEST', 'clientVersionId 가 다른 노트의 버전에 이미 쓰였습니다.');
    if (v.contentHash.toLowerCase() !== meta.contentHash.toLowerCase()) return err(res, 400, 'INVALID_REQUEST', '같은 clientVersionId 로 다른 내용을 보냈습니다.');
    return res.status(200).json({ versionId: v.versionId, receivedAt: iso(v.receivedAt), duplicate: true });
  }
  // 5. 과제 연결
  if (linkBlocked(req, res, note.projectMno)) return;
  // 6~8. 편집 위치·상태·기준 버전
  if (!ownsNote(req, note)) return err(res, 409, 'NOT_EDIT_OWNER', '이 기기에 편집권이 없습니다.');
  if (note.status !== 'WRITING' && note.status !== 'REJECT') return err(res, 409, 'NOT_WRITABLE', '점검 요청 이후에는 수정할 수 없습니다.');
  if ((meta.baseVersionId ?? null) !== note.latestVersionId) return err(res, 409, 'STALE_BASE', '서버 최신 버전과 다릅니다.');

  // 9. 전송 바이트만 센다(재사용 ref 의 저장 파일은 넣지 않는다)
  const totalBytes = Buffer.byteLength(req.body.meta, 'utf8') + Buffer.byteLength(noteContent, 'utf8')
    + (req.files || []).reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_UPLOAD_BYTES) return err(res, 413, 'TOO_LARGE', `업로드 크기 제한(${MAX_UPLOAD_BYTES} 바이트)을 넘었습니다.`);

  // 10. 이미지 필드·ref 규칙
  const uploads = (req.files || []).map((f) => {
    const m = /^inlineImages\[(.+)\]$/.exec(f.fieldname);
    const src = m ? m[1] : '';
    return { src, ref: src.startsWith(BLOB_PREFIX) ? src.slice(BLOB_PREFIX.length) : null, buffer: f.buffer, mimetype: f.mimetype, originalname: f.originalname };
  });
  if (uploads.some((img) => img.ref == null || !REF_PATTERN.test(img.ref))) {
    return err(res, 400, 'INVALID_REQUEST', '이미지 필드는 inlineImages[blob:goono-app/{ref}] 이고 ref 는 [A-Za-z0-9-] 16~64자여야 합니다.');
  }
  const uploadRefs = new Set(uploads.map((u) => u.ref));
  if (reusedRefs.some((r) => !REF_PATTERN.test(r)) || new Set(reusedRefs).size !== reusedRefs.length
    || reusedRefs.some((r) => uploadRefs.has(r))) {
    return err(res, 400, 'INVALID_REQUEST', 'reusedRefs 는 겹치지 않는 ref 이고 업로드 이미지와 겹치지 않아야 합니다.');
  }
  const bodyRefs = [...noteContent.matchAll(BODY_REF_PATTERN)].map((m) => m[1]);
  if (bodyRefs.some((r) => !uploadRefs.has(r) && !reusedRefs.includes(r))) {
    return err(res, 400, 'INVALID_REQUEST', '본문의 이미지가 업로드에도 reusedRefs 에도 없습니다.');
  }
  // 11. 재사용 ref 는 이 노트에 저장된 {noteMno}-{ref}.png 에서 읽는다
  const reused = [];
  for (const ref of reusedRefs) {
    const rec = note.images[ref];
    const file = rec && rec.saveNm === `${note.noteMno}-${ref}.png` ? path.join(IMAGE_DIR, rec.saveNm) : null;
    if (!file || !fs.existsSync(file)) {
      return err(res, 400, 'REUSED_REF_MISSING', `이 노트에 재사용할 이미지(${ref})가 없습니다. 전체를 다시 보내세요.`);
    }
    reused.push({ ref, buffer: fs.readFileSync(file), saveNm: rec.saveNm });
  }
  // 12. 내용 해시(업로드 + 재사용)
  if (meta.contentHash.toLowerCase() !== contentHash(noteContent, [...uploads, ...reused])) {
    return err(res, 422, 'HASH_MISMATCH', '전송 중 내용이 손상되었습니다.');
  }
  // 13. 이 노트에 같은 ref 로 다른 이미지가 이미 있으면 거부(앞 버전의 이미지를 덮어쓰지 않는다)
  if (uploads.some((img) => note.images[img.ref] && note.images[img.ref].sha256 !== sha256hex(img.buffer))) {
    return err(res, 400, 'INVALID_REQUEST', '이 노트에 같은 ref 의 다른 이미지가 이미 있습니다. 이미지 ref 는 내용마다 달라야 합니다.');
  }

  // ElnNoteEditorService.createNoteEditorDtl과 같은 규칙: 이미지를 {noteMno}-{ref}.{ext} 로 저장(같은 바이트면 다시 쓰지 않음)하고 경로 치환
  let html = noteContent;
  const point = (ref, saveNm) => {
    html = html.split(`src="${BLOB_PREFIX}${ref}"`).join(`src="/editor-inline-images/${saveNm}?noteMno=${note.noteMno}"`);
  };
  for (const img of uploads) {
    let rec = note.images[img.ref];
    if (!rec) {
      const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(img.originalname || '') || [, (img.mimetype || '').split('/')[1] || 'bin'])[1];
      rec = { sha256: sha256hex(img.buffer), saveNm: `${note.noteMno}-${img.ref}.${ext}` };
      fs.writeFileSync(path.join(IMAGE_DIR, rec.saveNm), img.buffer);
      note.images[img.ref] = rec;
    }
    point(img.ref, rec.saveNm);
  }
  for (const img of reused) point(img.ref, img.saveNm);

  const v = { versionId: ++state.seq.version, noteMno: note.noteMno, clientVersionId: meta.clientVersionId,
    html, source: 'APP', deviceId: req.device.deviceId, deviceWrittenAt: meta.deviceWrittenAt, receivedAt: now(),
    contentHash: meta.contentHash, autoSave: !!meta.autoSave, imageCount: uploads.length + reused.length,
    uploadedImages: uploads.map((u) => u.ref), reusedImages: reused.map((r) => r.ref) };
  state.versions.set(v.versionId, v);
  state.clientVersions.set(v.clientVersionId, v.versionId);
  note.versionIds.push(v.versionId);
  note.latestVersionId = v.versionId;
  if (typeof meta.title === 'string' && meta.title.trim()) note.title = normalizeTitle(meta.title);
  note.updatedAt = now();
  res.status(201).json({ versionId: v.versionId, receivedAt: iso(v.receivedAt) });
});

api.post('/notes/:noteMno/release', auth, (req, res) => {
  // 평가 순서: 400 → 404 → 403 연결 → 409 NOT_EDIT_OWNER → 409 VERSION_MISMATCH
  if (!isPlainObject(req.body) || (req.body.lastVersionId != null && !Number.isInteger(req.body.lastVersionId))) {
    return err(res, 400, 'BAD_REQUEST', '요청 본문 { lastVersionId } 가 필요합니다.');
  }
  const note = state.notes.get(Number(req.params.noteMno));
  if (!note || note.ownerMno !== req.user.userMno) return err(res, 404, 'NOT_FOUND', '노트가 없습니다.');
  if (linkBlocked(req, res, note.projectMno)) return;
  if (!ownsNote(req, note)) return err(res, 409, 'NOT_EDIT_OWNER', '이 기기에 편집권이 없습니다.');
  if ((req.body.lastVersionId ?? null) !== note.latestVersionId) return err(res, 409, 'VERSION_MISMATCH', '아직 올라가지 않은 버전이 있습니다.');
  note.editLocation = { type: 'WEB' };
  note.history.push({ at: now(), event: 'RELEASED', by: req.device.deviceId });
  note.updatedAt = now();
  res.json({ status: note.status, editLocation: note.editLocation });
});

app.use('/api/app/v1', api);

// ── 테스트용 관리 ──
const admin = express.Router();
const userByLogin = (loginId) => USERS.find((u) => u.loginId === loginId);
admin.get('/state', (_req, res) => res.json({
  config,
  projects: state.projects,
  devices: [...state.devices.values()].map(({ tokenHash, prevTokenHash, ...d }) => d),
  links: [...state.links.values()].map((l) => {
    const d = deviceByMno(l.deviceMno);
    return { ...l, deviceId: d.deviceId, userMno: d.userMno, loginId: userOf(d.userMno).loginId,
      projectNm: projectOf(l.projectMno).name, effectiveStatus: effectiveStatus(l) };
  }),
  requests: [...state.requests.values()].map(({ tokenHash, ...r }) => ({ ...r, status: requestStatus(r), confirmNumber: confirmNumber({ tokenHash }),
    loginId: userOf(r.userMno).loginId, projectNm: r.projectMno == null ? null : projectOf(r.projectMno).name })),
  pairingCodes: [...state.pairingCodes.values()].map((c) => ({ code: c.code, userMno: c.userMno, projectMno: c.projectMno,
    createdAt: iso(c.createdAt), expiresAt: iso(c.expiresAt), usedAt: iso(c.usedAt), invalidatedAt: iso(c.invalidatedAt) })),
  notes: [...state.notes.values()].map((n) => ({ ...noteView(n), versionIds: n.versionIds, history: n.history, images: n.images })),
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
  for (const k of ['requestTtlMs', 'deliveryTtlMs']) {
    if (b[k] !== undefined && b[k] !== null && !(Number.isFinite(b[k]) && b[k] > 0)) return err(res, 400, 'BAD_REQUEST', `${k}는 양수이거나 null 이어야 합니다.`);
  }
  config = { ...config, ...b };
  res.json(config);
});
/**
 * 연구책임자의 과제 화면 "QR 만들기"(POST /api/eln/app/project/pairing-code) 대신. 그 과제 구성원에게만(아니면 404).
 * 같은 (과제, 연구원)으로 새로 만들면 그 이전 미사용 코드는 무효(다른 과제 코드는 그대로).
 */
admin.post('/pairing-code', (req, res) => {
  const { loginId, projectMno, ttlMs } = req.body || {};
  if (!Number.isInteger(projectMno)) return err(res, 400, 'BAD_REQUEST', 'projectMno가 필요합니다.');
  if (ttlMs !== undefined && !(Number.isFinite(ttlMs) && ttlMs > 0)) return err(res, 400, 'BAD_REQUEST', 'ttlMs는 양수여야 합니다.');
  const user = userByLogin(loginId);
  const project = projectOf(projectMno);
  if (!user || !isMember(project, user.userMno)) return err(res, 404, 'NOT_FOUND', '그 과제의 구성원이 아닙니다.');
  for (const c of state.pairingCodes.values()) {
    if (c.userMno === user.userMno && c.projectMno === projectMno && !c.usedAt && !c.invalidatedAt) c.invalidatedAt = now();
  }
  let code;
  do {
    code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (state.pairingCodes.has(code));
  const expiresAt = new Date(Date.now() + (ttlMs ?? PAIRING_TTL_MS));
  state.pairingCodes.set(code, { code, userMno: user.userMno, projectMno, issuerMno: project.leaders[0], createdAt: now(), expiresAt, usedAt: null, invalidatedAt: null });
  const server = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const qrPayload = `goono-note://pair?server=${encodeURIComponent(server)}&code=${encodeURIComponent(displayCode(code))}`;
  // 실제 웹 API 와 같은 필드. 테스트용이라 기능이 꺼져 있어도 코드는 만든다(실제 웹은 { appEnabled: false } 만)
  res.json({ appEnabled: config.appEnabled !== false, code: displayCode(code), qrPayload, expiresAt: iso(expiresAt),
    expiresInSeconds: secondsLeft(expiresAt), userNm: user.name, projectNm: project.name });
});
/** 연구원의 대시보드 승인 창 대신. 그 사용자의 가장 오래된 PENDING(기한 안) 요청을 승인(기본)·거절. 없으면 404. */
admin.post('/approve', (req, res) => {
  const { loginId, decision = 'APPROVE' } = req.body || {};
  if (decision !== 'APPROVE' && decision !== 'REJECT') return err(res, 400, 'BAD_REQUEST', 'decision은 APPROVE 또는 REJECT 입니다.');
  const user = userByLogin(loginId);
  const r = user && [...state.requests.values()].filter((x) => x.userMno === user.userMno && livePending(x))
    .sort((a, b) => a.createdAt - b.createdAt || a.requestMno - b.requestMno)[0];
  if (!r) return err(res, 404, 'NOT_FOUND', '승인 대기 중인 요청이 없습니다.');
  const out = decideRequest(r, decision === 'APPROVE');
  if (out.error) return err(res, ...out.error);
  res.json({ requestMno: r.requestMno, status: out.status, confirmNumber: confirmNumber(r) });
});
/**
 * 연구책임자의 "연결 끊기"(POST /api/eln/app/project/unlink) 대신. 이미 끊겼으면 ended 0.
 * 이력 작성자 = 책임자(leaderLoginId, 없으면 그 과제의 첫 책임자 researcher1). 책임자가 아니면 403.
 */
admin.post('/unlink', (req, res) => {
  const { deviceId, loginId, projectMno, leaderLoginId } = req.body || {};
  const user = userByLogin(loginId);
  const device = user && state.devices.get(deviceKey(deviceId, user.userMno));
  const link = device && linkFor(device, projectMno);
  if (!link) return err(res, 404, 'NOT_FOUND', '연결이 없습니다.');
  const project = projectOf(projectMno);
  const leaderMno = leaderLoginId === undefined ? project.leaders[0] : userByLogin(leaderLoginId)?.userMno;
  if (!project.leaders.includes(leaderMno)) return err(res, 403, 'FORBIDDEN', '과제 책임자만 연결을 끊을 수 있습니다.');
  res.json({ ended: endLink(link, 'LEADER', leaderMno) });
});
/** 과제 편집 가능 여부(진행 종료·유예 만료·삭제 등 → false, 유예 연장·재개 → true) */
admin.post('/projects/:projectMno/state', (req, res) => {
  const project = projectOf(Number(req.params.projectMno));
  if (!project) return err(res, 404, 'NOT_FOUND', '과제가 없습니다.');
  if (typeof req.body?.editable !== 'boolean') return err(res, 400, 'BAD_REQUEST', 'editable은 boolean이어야 합니다.');
  project.editable = req.body.editable;
  res.json(project);
});
/**
 * 구성원에서 뺀다. 요청 시 곧바로 그 연결이 ENDED 로 보이고(403 PROJECT_NOT_LINKED), 하루 작업이 끊김(구성원 제외)을 기록한다.
 * 실제 서버와 다른 점: 서버는 과제 화면의 구성원 삭제(deleteProjectMembers) 훅에서 그 자리에서 끊는다(이력 작성자 = 삭제한 사용자).
 * 이 경로는 그 훅을 거치지 않고 빠진 경우(하루 작업이 작성자 0 으로 기록)를 흉내 낸다.
 */
admin.post('/projects/:projectMno/remove-member', (req, res) => {
  const project = projectOf(Number(req.params.projectMno));
  const user = userByLogin(req.body?.loginId);
  if (!project || !user) return err(res, 404, 'NOT_FOUND', '과제 또는 사용자가 없습니다.');
  project.members = project.members.filter((m) => m !== user.userMno);
  res.json(project);
});
/** 마지막 접속 시각을 daysAgo 일 전으로(장기 미접속 시험) */
admin.post('/devices/:deviceId/last-seen', (req, res) => {
  const { loginId, daysAgo } = req.body || {};
  const user = userByLogin(loginId);
  const device = user && state.devices.get(deviceKey(req.params.deviceId, user.userMno));
  if (!device) return err(res, 404, 'NOT_FOUND', '기기가 없습니다.');
  if (!(Number.isFinite(daysAgo) && daysAgo >= 0)) return err(res, 400, 'BAD_REQUEST', 'daysAgo는 0 이상이어야 합니다.');
  device.lastSeenAt = new Date(Date.now() - daysAgo * DAY_MS);
  res.json({ deviceMno: device.deviceMno, lastSeenAt: iso(device.lastSeenAt) });
});
/**
 * 하루 1번 작업(서버 AppLinkScheduler). 살아 있는 연결마다 우선순위: 끊김 → (그대로) / 구성원 아님 → 끊음(구성원 제외) /
 * 장기 미접속(30일) → 끊음(장기 미접속) / ACTIVE·편집 불가 → 중지(노트 WEB, 이력 "과제 종료") / SUSPENDED·편집 가능 → 재개.
 */
admin.post('/daily', (_req, res) => {
  const out = { suspended: 0, resumed: 0, ended: 0 };
  const inactiveBefore = Date.now() - INACTIVE_DAYS * DAY_MS;
  for (const link of [...state.links.values()]) {
    if (link.status === 'ENDED') continue;
    const device = deviceByMno(link.deviceMno);
    const project = projectOf(link.projectMno);
    const inactive = (device.lastSeenAt ?? device.registeredAt).getTime() < inactiveBefore;
    if (!isMember(project, device.userMno)) out.ended += endLink(link, 'MEMBER_REMOVED', SYSTEM_ACTOR);
    else if (inactive) out.ended += endLink(link, 'INACTIVE', SYSTEM_ACTOR);
    else if (link.status === 'ACTIVE' && !project.editable) {
      Object.assign(link, { status: 'SUSPENDED', suspendedAt: now() });
      returnNotesToWeb(device, link.projectMno, SUSPEND_HISTORY_TEXT, SYSTEM_ACTOR);
      out.suspended++;
    } else if (link.status === 'SUSPENDED' && project.editable) {
      Object.assign(link, { status: 'ACTIVE', suspendedAt: null });
      out.resumed++;
    }
  }
  // 결정·만료된 지 7일 지난 승인 요청을 지운다
  const oldBefore = Date.now() - 7 * DAY_MS;
  for (const r of [...state.requests.values()]) {
    if ((r.decidedAt && r.decidedAt.getTime() < oldBefore) || r.expiresAt.getTime() < oldBefore) state.requests.delete(r.requestMno);
  }
  res.json(out);
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
/** 저장 이미지 기록을 지운다 — 그 뒤 재사용 ref 는 400 REUSED_REF_MISSING(앱의 전체 다시 보내기 시험) */
admin.post('/notes/:noteMno/forget-images', (req, res) => {
  const note = state.notes.get(Number(req.params.noteMno));
  if (!note) return err(res, 404, 'NOT_FOUND', '노트가 없습니다.');
  note.images = {};
  res.json({ ok: true });
});
/** 마이페이지 "사용 중지" 대신: 사용 중지 + 모든 과제 연결 끊기 + 노트 WEB(이력 "기기 사용 중지") */
admin.post('/devices/:deviceId/revoke', (req, res) => {
  // 본문에 userMno가 있으면 그 사용자의 묶음만, 없으면 이 기기 ID의 모든 묶음
  const found = [...state.devices.values()].filter((d) => d.deviceId === req.params.deviceId
    && (req.body?.userMno === undefined || d.userMno === req.body.userMno));
  if (!found.length) return err(res, 404, 'NOT_FOUND', '기기가 없습니다.');
  let ended = 0;
  for (const d of found) {
    Object.assign(d, { revoked: true, revokedAt: now(), prevValidUntil: null }); // 갱신 유예도 끝낸다(이전 토큰은 DEVICE_REVOKED)
    ended += endAllLinks(d, 'REVOKED', d.userMno);
    cancelBundleRequests(d);
  }
  res.json({ ok: true, ended });
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
      `<li><a href="/versions/${v.versionId}">버전 ${v.versionId}</a> · 서버 수신 ${esc(v.receivedAt.toISOString())} · 기기 작성 ${esc(v.deviceWrittenAt)} · 이미지 ${v.imageCount}(새로 ${v.uploadedImages.length})${v.autoSave ? ' · 자동' : ''}</li>`).join('');
    const project = projectOf(n.projectMno);
    return `<section style="border:1px solid #ccd;border-radius:8px;padding:12px;margin:12px 0"><b>${esc(n.title)}</b> <small>#${n.noteMno} · ${esc(project?.name)} · ${esc(n.status)} · 편집 위치: ${loc}</small><ul>${vers || '<li>버전 없음</li>'}</ul></section>`;
  }).join('');
  const links = [...state.links.values()].map((l) => {
    const d = deviceByMno(l.deviceMno);
    return `<li>${esc(projectOf(l.projectMno).name)} · ${esc(userOf(d.userMno).name)} · ${esc(d.name)} · ${esc(effectiveStatus(l))}${l.endReason ? ` (${esc(END_REASON_TEXT[l.endReason])})` : ''}</li>`;
  }).join('');
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>구노 ELN (모의)</title><body style="max-width:900px;margin:24px auto;font-family:sans-serif"><h1>구노 ELN 모의 서버</h1><h2>과제 연결</h2><ul>${links || '<li>없음</li>'}</ul><h2>노트</h2><p>태블릿 앱이 올린 노트와 버전입니다.</p>${rows || '<p>아직 없습니다.</p>'}</body>`);
});

const server = app.listen(PORT, () => {
  const port = server.address().port;
  console.log(`[mock-eln] http://localhost:${port}  (API: /api/app/v1, 계정 researcher1·researcher2 / goono1234, 과제 QR: POST /__admin/pairing-code {loginId, projectMno} → 승인: POST /__admin/approve {loginId})`);
});
