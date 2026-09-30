/**
 * 체험 모드 — 구노 서버 없이 앱 안에서 동기화 API(v1)를 흉내 낸다 (docs/SYNC-API.md, mock-server 와 같은 규칙).
 *
 * 받은 노트·버전의 목록(메타데이터)만 이 기기 브라우저 저장소에 둔다. 페이지 그림은 기기의 버전 기록에 이미 있으므로
 * 체험 서버에는 쪽수·해시만 남긴다. 기기가 오프라인이면 연결 실패로 응답해 오프라인 작성도 그대로 체험할 수 있다.
 */
import { contentHash } from './images.ts';

export const DEMO_SERVER = 'demo://goono';
export const isDemoServer = (url: string | undefined | null) => (url ?? '').trim().replace(/\/+$/, '') === DEMO_SERVER;

const KEY = 'goono-note.demo-server.v1';
const DAY = 86_400_000;
const PROJECTS = [
  { projectMno: 1, name: '시료 A 열처리', writable: true },
  { projectMno: 2, name: '세포 배양 조건 최적화', writable: true },
];
const USER = { userMno: 1, loginId: 'demo', name: '체험 사용자' };

interface DemoNote {
  noteMno: number; clientNoteId: string; title: string; projectMno: number;
  status: 'WRITING' | 'INSPECTION' | 'COMPLETE' | 'REJECT';
  editLocation: { type: 'DEVICE'; deviceId: string } | { type: 'WEB' };
  latestVersionId: number | null; updatedAt: string;
}
interface DemoVersion { versionId: number; noteMno: number; clientVersionId: string; receivedAt: string; pages: number; contentHash: string; autoSave: boolean }
interface DemoState { seq: { note: number; version: number }; deviceId: string | null; notes: DemoNote[]; versions: DemoVersion[] }

function load(): DemoState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as DemoState;
  } catch { /* 저장소를 못 쓰면 매번 새로 */ }
  return { seq: { note: 100, version: 5000 }, deviceId: null, notes: [], versions: [] };
}
function save(s: DemoState) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 무시 */ }
}

/** 체험 서버가 받은 버전 (화면 표시용) */
export function demoReceived(): DemoState {
  return load();
}

export class DemoError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly body: Record<string, unknown> = {}) { super(message); }
}

const iso = (t = Date.now()) => new Date(t).toISOString();
const token = () => ({ token: 'demo-token', tokenExpiresAt: iso(Date.now() + 14 * DAY), offlineGraceDays: 14, serverTime: iso() });
const view = (n: DemoNote) => ({ ...n });

/** api.ts 의 fetch 대신 불린다. 응답 본문을 돌려주거나 DemoError 를 던진다 */
export async function demoCall(path: string, init: RequestInit): Promise<unknown> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new TypeError('offline');
  await new Promise((r) => setTimeout(r, 120)); // 네트워크 느낌
  const s = load();
  const method = (init.method ?? 'GET').toUpperCase();
  const json = () => (typeof init.body === 'string' ? JSON.parse(init.body) : {}) as Record<string, unknown>;

  if (method === 'POST' && path === '/devices/register') {
    const b = json() as { device?: { id?: string } };
    s.deviceId = b.device?.id ?? 'demo-device';
    save(s);
    return { ...token(), user: USER };
  }
  if (method === 'POST' && path === '/devices/refresh') return token();
  if (method === 'GET' && path === '/bootstrap') {
    return { user: USER, projects: PROJECTS, policy: { offlineGraceDays: 14, maxImageBytes: 50 * 1024 * 1024 }, serverTime: iso() };
  }
  if (method === 'GET' && path === '/notes') return { notes: s.notes.map(view) };

  if (method === 'POST' && path === '/notes') {
    const b = json() as { clientNoteId: string; projectMno: number; title: string };
    const existing = s.notes.find((n) => n.clientNoteId === b.clientNoteId);
    if (existing) return view(existing);
    const n: DemoNote = {
      noteMno: ++s.seq.note, clientNoteId: b.clientNoteId, title: b.title, projectMno: b.projectMno, status: 'WRITING',
      editLocation: { type: 'DEVICE', deviceId: s.deviceId ?? 'demo-device' }, latestVersionId: null, updatedAt: iso(),
    };
    s.notes.push(n);
    save(s);
    return view(n);
  }

  let m = /^\/notes\/(\d+)\/versions$/.exec(path);
  if (method === 'POST' && m) {
    const note = s.notes.find((n) => n.noteMno === Number(m![1]));
    if (!note) throw new DemoError(404, 'NOT_FOUND', '노트가 없습니다.');
    const form = init.body as FormData;
    const meta = JSON.parse(String(form.get('meta') ?? '{}')) as { clientVersionId: string; baseVersionId: number | null; contentHash: string; autoSave?: boolean; title?: string };
    const dup = s.versions.find((v) => v.clientVersionId === meta.clientVersionId);
    if (dup) return { versionId: dup.versionId, receivedAt: dup.receivedAt, duplicate: true };
    if (note.editLocation.type !== 'DEVICE') throw new DemoError(409, 'NOT_EDIT_OWNER', '이 기기에 편집권이 없습니다.', { status: note.status, editLocation: note.editLocation });
    if ((meta.baseVersionId ?? null) !== note.latestVersionId) throw new DemoError(409, 'STALE_BASE', '서버 최신 버전과 다릅니다.');
    // 내용 해시 검증 (실서버와 같은 규칙)
    const html = String(form.get('noteContent') ?? '');
    const images: { ref: string; bytes: Uint8Array }[] = [];
    for (const [k, v] of form.entries()) {
      const mm = /^inlineImages\[blob:goono-app\/(.+)\]$/.exec(k);
      if (mm && v instanceof Blob) images.push({ ref: mm[1], bytes: new Uint8Array(await v.arrayBuffer()) });
    }
    if ((await contentHash(html, images)) !== meta.contentHash) throw new DemoError(422, 'HASH_MISMATCH', '전송 중 내용이 손상되었습니다.');
    const v: DemoVersion = {
      versionId: ++s.seq.version, noteMno: note.noteMno, clientVersionId: meta.clientVersionId, receivedAt: iso(),
      pages: images.length, contentHash: meta.contentHash, autoSave: !!meta.autoSave,
    };
    s.versions.push(v);
    note.latestVersionId = v.versionId;
    note.updatedAt = v.receivedAt;
    if (meta.title?.trim()) note.title = meta.title.trim();
    save(s);
    return { versionId: v.versionId, receivedAt: v.receivedAt };
  }

  m = /^\/notes\/(\d+)\/release$/.exec(path);
  if (method === 'POST' && m) {
    const note = s.notes.find((n) => n.noteMno === Number(m![1]));
    if (!note) throw new DemoError(404, 'NOT_FOUND', '노트가 없습니다.');
    const b = json() as { lastVersionId: number | null };
    if ((b.lastVersionId ?? null) !== note.latestVersionId) throw new DemoError(409, 'VERSION_MISMATCH', '아직 올라가지 않은 버전이 있습니다.');
    note.editLocation = { type: 'WEB' };
    note.updatedAt = iso();
    save(s);
    return { status: note.status, editLocation: note.editLocation };
  }
  throw new DemoError(404, 'NOT_FOUND', `체험 서버에 없는 요청입니다: ${method} ${path}`);
}

/** 체험 서버 기록 지우기 (로그아웃 시) */
export function resetDemo() {
  try { localStorage.removeItem(KEY); } catch { /* 무시 */ }
}
