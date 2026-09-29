import { api, ApiError } from './api.ts';
import { db } from './db.ts';
import { uploadPayload } from './notes.ts';
import { applyServerNote, classifyUploadError, REJECT_MESSAGES } from './rules.ts';
import type { LocalNote, LocalVersion, Session } from './types.ts';

/**
 * 동기화 — 앱 → 서버 단방향.
 *
 *  1. 토큰 갱신(오프라인 기한 연장)  2. 기준 정보  3. 서버의 노트 상태(편집 위치·점검 상태) 반영
 *  4. 서버에 없는 노트 만들기  5. 대기 버전을 순서대로 올리기  6. 작성 완료 요청된 노트 반납
 *
 * 서버가 받지 않은 버전은 지우지 않고 REJECTED(미반영 기록)로 남긴다.
 */
export interface SyncResult {
  ok: boolean;
  sent: number;
  rejected: number;
  released: number;
  /** 연결 문제로 중단됨 */
  offline?: boolean;
  error?: string;
}

let running: Promise<SyncResult> | null = null;
let again = false;

/** 한 번에 하나만 돈다. 도는 중에 요청되면 끝난 뒤 한 번 더 돈다 */
export function syncNow(): Promise<SyncResult> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    // 여러 번 돌면 결과를 합친다 (앞 회차에서 올라간 버전도 호출자에게 알려야 한다)
    const total: SyncResult = { ok: true, sent: 0, rejected: 0, released: 0 };
    let r: SyncResult;
    do {
      again = false;
      r = await runSync();
      total.sent += r.sent;
      total.rejected += r.rejected;
      total.released += r.released;
    } while (again && r.ok);
    return { ...r, sent: total.sent, rejected: total.rejected, released: total.released };
  })().finally(() => { running = null; });
  return running;
}

export function isSyncing(): boolean { return running != null; }

async function markAuth(e: ApiError): Promise<void> {
  await db.updateSession((s) => (e.code === 'DEVICE_REVOKED' ? { ...s, revoked: true } : { ...s, needsLogin: true }));
}

async function runSync(): Promise<SyncResult> {
  const result: SyncResult = { ok: false, sent: 0, rejected: 0, released: 0 };
  let session = await db.getSession();
  if (!session) return { ...result, error: '로그인이 필요합니다.' };
  if (session.revoked || session.needsLogin) return { ...result, error: '로그인이 필요합니다.' };

  try {
    const t = await api.refresh(session.serverUrl, session.token);
    const now = new Date().toISOString();
    session = (await db.updateSession((s) => ({
      ...s, token: t.token, tokenExpiresAt: t.tokenExpiresAt, offlineGraceDays: t.offlineGraceDays,
      lastServerContactAt: now, clockHighWater: Math.max(s.clockHighWater ?? 0, Date.parse(t.serverTime) || 0, Date.now()),
    }))) as Session;

    const boot = await api.bootstrap(session.serverUrl, session.token);
    await db.putMeta({ projects: boot.projects, maxImageBytes: boot.policy.maxImageBytes, fetchedAt: now });

    const { notes: serverNotes } = await api.notes(session.serverUrl, session.token);
    const byClientId = new Map(serverNotes.map((n) => [n.clientNoteId, n]));
    const deviceId = session.deviceId;
    for (const n of await db.listNotes()) {
      await db.updateNote(n.id, (cur) => applyServerNote(cur, byClientId.get(cur.id), deviceId));
    }

    // 오래된 노트부터
    const notes = (await db.listNotes()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const n of notes) {
      const r = await syncNote(session, n);
      result.sent += r.sent;
      result.rejected += r.rejected;
      result.released += r.released;
    }

    await db.updateSession((s) => ({ ...s, lastSyncAt: new Date().toISOString() }));
    return { ...result, ok: true };
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 401) {
        await markAuth(e);
        return { ...result, error: e.message };
      }
      return { ...result, offline: e.isNetwork, error: e.message };
    }
    return { ...result, error: String((e as Error)?.message ?? e) };
  }
}

async function rejectVersion(v: LocalVersion, code: string, message?: string): Promise<void> {
  await db.updateVersion(v.noteId, v.id, (cur) => ({
    ...cur, state: 'REJECTED', rejectCode: code, rejectMessage: REJECT_MESSAGES[code] ?? message ?? code,
  }));
}

/** 노트 하나 동기화. ApiError(연결·인증)는 위로 던져 전체 동기화를 멈춘다 */
async function syncNote(session: Session, note: LocalNote): Promise<{ sent: number; rejected: number; released: number }> {
  const out = { sent: 0, rejected: 0, released: 0 };
  const { serverUrl, token } = session;
  const pending = (await db.listVersions(note.id)).filter((v) => v.state === 'PENDING').sort((a, b) => a.seq - b.seq);
  if (!pending.length && !note.releaseRequested && note.noteMno != null) return out;

  // 서버에 노트 만들기 (clientNoteId 로 멱등)
  let noteMno = note.noteMno;
  if (noteMno == null) {
    try {
      const r = await api.createNote(serverUrl, token, {
        clientNoteId: note.id, projectMno: note.projectMno, title: note.title, deviceCreatedAt: note.createdAt,
      });
      noteMno = r.noteMno;
      await db.updateNote(note.id, (n) => ({ ...n, noteMno: r.noteMno, serverStatus: r.status, syncIssue: null }));
    } catch (e) {
      if (!(e instanceof ApiError) || e.isNetwork || e.status === 401 || e.status >= 500) throw e;
      await db.updateNote(note.id, (n) => ({
        ...n, releaseRequested: false,
        syncIssue: { code: e.code, message: REJECT_MESSAGES[e.code] ?? e.message, at: new Date().toISOString() },
      }));
      for (const v of pending) await rejectVersion(v, e.code, e.message);
      out.rejected += pending.length;
      return out;
    }
  }

  let base = note.latestServerVersionId;
  let noteRejected = false;
  for (let i = 0; i < pending.length; i++) {
    const v = pending[i];
    const payload = await uploadPayload(v);
    if (payload.missing.length) {
      await rejectVersion(v, 'IMAGE_MISSING');
      out.rejected++;
      continue;
    }
    try {
      const r = await api.uploadVersion(serverUrl, token, noteMno, {
        meta: { clientVersionId: v.id, baseVersionId: base, deviceWrittenAt: v.deviceWrittenAt, contentHash: v.contentHash, autoSave: v.autoSave },
        noteContent: payload.html,
        images: payload.images,
      });
      base = r.versionId;
      await db.updateVersion(note.id, v.id, (cur) => ({ ...cur, state: 'SENT', serverVersionId: r.versionId, receivedAt: r.receivedAt, lastError: undefined }));
      await db.updateNote(note.id, (n) => ({ ...n, latestServerVersionId: r.versionId }));
      out.sent++;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      const outcome = classifyUploadError(e.status, e.code, v.attempts ?? 0);
      if (outcome === 'STOP' || outcome === 'AUTH') throw e;
      if (outcome === 'RETRY') {
        await db.updateVersion(note.id, v.id, (cur) => ({ ...cur, attempts: (cur.attempts ?? 0) + 1, lastError: e.message }));
        break; // 순서를 지키기 위해 이 노트의 뒤 버전은 다음 동기화 때
      }
      if (outcome === 'SKIP') {
        await rejectVersion(v, e.code, e.message);
        out.rejected++;
        continue;
      }
      // REJECT_NOTE — 남은 버전 모두 미반영
      for (const rest of pending.slice(i)) await rejectVersion(rest, e.code, e.message);
      out.rejected += pending.length - i;
      noteRejected = true;
      const body = e.body as { status?: LocalNote['serverStatus']; editLocation?: { type: string } };
      await db.updateNote(note.id, (n) => ({
        ...n,
        releaseRequested: false,
        serverStatus: body.status ?? n.serverStatus,
        ...(e.code === 'NOT_EDIT_OWNER' ? { editLocation: 'WEB' as const, reclaimed: true } : {}),
        syncIssue: { code: e.code, message: REJECT_MESSAGES[e.code] ?? e.message, at: new Date().toISOString() },
      }));
      break;
    }
  }

  // 작성 완료 반납 — 대기 버전이 모두 올라간 경우에만
  const fresh = await db.getNote(note.id);
  if (fresh?.releaseRequested && !noteRejected) {
    const stillPending = (await db.listVersions(note.id)).some((v) => v.state === 'PENDING');
    if (!stillPending) {
      try {
        await api.release(serverUrl, token, noteMno, fresh.latestServerVersionId);
        await db.updateNote(note.id, (n) => ({ ...n, released: true, releaseRequested: false, editLocation: 'WEB', syncIssue: null }));
        out.released++;
      } catch (e) {
        if (!(e instanceof ApiError) || e.isNetwork || e.status === 401 || e.status >= 500) throw e;
        await db.updateNote(note.id, (n) => ({
          ...n,
          releaseRequested: false,
          ...(e.code === 'NOT_EDIT_OWNER' ? { editLocation: 'WEB' as const, reclaimed: true } : {}),
          syncIssue: { code: e.code, message: e.message, at: new Date().toISOString() },
        }));
      }
    }
  }
  return out;
}
