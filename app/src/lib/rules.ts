import type { LocalNote, ServerNote, Session } from './types.ts';

/**
 * 편집 가능 여부·서버 상태 반영·오류 분류 규칙.
 * 저장소·네트워크에 의존하지 않는 순수 함수만 둔다(단위 테스트 대상).
 */

/** 시계를 이만큼 넘게 되돌리면 되돌린 것으로 본다 (시간대 변경·NTP 보정 여유) */
export const CLOCK_ROLLBACK_TOLERANCE_MS = 10 * 60_000;

export type SessionLock = 'REVOKED' | 'NEEDS_LOGIN' | 'OFFLINE_EXPIRED' | 'CLOCK_ROLLBACK';

export function sessionLock(s: Session, now: number): SessionLock | null {
  if (s.revoked) return 'REVOKED';
  if (s.needsLogin) return 'NEEDS_LOGIN';
  if (s.clockHighWater != null && now < s.clockHighWater - CLOCK_ROLLBACK_TOLERANCE_MS) return 'CLOCK_ROLLBACK';
  if (now > Date.parse(s.tokenExpiresAt)) return 'OFFLINE_EXPIRED';
  return null;
}

export const LOCK_MESSAGES: Record<SessionLock, string> = {
  REVOKED: '이 기기는 구노에서 사용 중지되었습니다. 기기에 남은 기록은 보관되며, 관리자에게 문의하세요.',
  NEEDS_LOGIN: '로그인이 만료되었습니다. 다시 로그인하면 작성과 동기화를 이어갈 수 있습니다.',
  OFFLINE_EXPIRED: '오프라인 작성 기한이 지났습니다. 인터넷에 연결해 동기화하면 다시 작성할 수 있습니다.',
  CLOCK_ROLLBACK: '기기 시계가 과거로 바뀌었습니다. 시계를 바로잡거나 인터넷에 연결해 동기화하세요.',
};

export type EditBlock =
  | { kind: 'LOCK'; lock: SessionLock; message: string }
  | { kind: 'RELEASED' | 'RELEASE_PENDING' | 'RECLAIMED' | 'NOT_WRITABLE'; message: string };

/** 이 노트를 지금 이 기기에서 편집할 수 없는 이유. 편집 가능하면 null */
export function editBlock(note: LocalNote, s: Session, now: number): EditBlock | null {
  const lock = sessionLock(s, now);
  if (lock) return { kind: 'LOCK', lock, message: LOCK_MESSAGES[lock] };
  if (note.released) return { kind: 'RELEASED', message: '작성 완료되어 구노 웹으로 넘겼습니다. 점검 요청은 구노 웹에서 하세요.' };
  if (note.releaseRequested) return { kind: 'RELEASE_PENDING', message: '작성 완료 처리 중입니다. 다음 동기화 때 모든 기록을 올리고 웹으로 넘깁니다.' };
  if (note.reclaimed || note.editLocation !== 'THIS_DEVICE') {
    return { kind: 'RECLAIMED', message: '편집권이 구노 웹으로 회수되었습니다. 이 기기에서 쓴 미반영 기록은 "기록"에서 확인할 수 있습니다.' };
  }
  if (note.serverStatus === 'INSPECTION' || note.serverStatus === 'COMPLETE') {
    return { kind: 'NOT_WRITABLE', message: '점검 요청 이후에는 수정할 수 없습니다.' };
  }
  return null;
}

/** 서버 목록의 노트 상태를 기기 노트에 반영한다 (내용은 반영하지 않는다 — 내용은 단방향) */
export function applyServerNote(local: LocalNote, server: ServerNote | undefined, deviceId: string): LocalNote {
  if (!server) return local;
  const mine = server.editLocation.type === 'DEVICE' && server.editLocation.deviceId === deviceId;
  const next: LocalNote = { ...local, noteMno: local.noteMno ?? server.noteMno, serverStatus: server.status };
  if (mine) {
    next.editLocation = 'THIS_DEVICE';
    next.reclaimed = false;
    next.released = false;
  } else {
    next.editLocation = 'WEB';
    if (local.releaseRequested && server.latestVersionId === local.latestServerVersionId) {
      // 반납 요청의 응답만 못 받은 경우
      next.released = true;
      next.releaseRequested = false;
    } else if (!local.released) {
      next.reclaimed = true;
      next.releaseRequested = false;
    }
  }
  return next;
}

/**
 * 버전 업로드 실패 처리:
 *  STOP        — 연결 문제·서버 장애. 이번 동기화를 멈추고 나중에 다시 (버전은 대기 유지)
 *  AUTH        — 토큰 만료/기기 폐기. 세션을 잠근다 (버전은 대기 유지)
 *  RETRY       — 이 버전만 다음에 다시 (전송 중 손상)
 *  SKIP        — 이 버전만 미반영 처리하고 다음 버전 계속 (버전은 전체 스냅숏이라 다음 버전이 내용을 포함)
 *  REJECT_NOTE — 이 노트의 남은 대기 버전 모두 미반영 처리 (편집권 없음·점검 이후·서버 버전 불일치)
 */
export type UploadOutcome = 'STOP' | 'AUTH' | 'RETRY' | 'SKIP' | 'REJECT_NOTE';
export const MAX_HASH_RETRIES = 3;

export function classifyUploadError(status: number, code: string, attempts: number): UploadOutcome {
  if (status === 0 || status >= 500 || status === 429) return 'STOP';
  if (status === 401) return 'AUTH';
  if (code === 'HASH_MISMATCH') return attempts + 1 >= MAX_HASH_RETRIES ? 'SKIP' : 'RETRY';
  if (code === 'NOT_EDIT_OWNER' || code === 'NOT_WRITABLE' || code === 'STALE_BASE' || status === 404 || status === 403) return 'REJECT_NOTE';
  return 'SKIP';
}

export const REJECT_MESSAGES: Record<string, string> = {
  NOT_EDIT_OWNER: '편집권이 회수된 뒤라 서버가 받지 않았습니다.',
  NOT_WRITABLE: '점검 요청 이후라 서버가 받지 않았습니다.',
  STALE_BASE: '서버의 최신 버전이 이 기기가 아는 것과 달라 받지 않았습니다.',
  HASH_MISMATCH: '전송 중 손상이 반복되어 올리지 못했습니다.',
  TOO_LARGE: '크기 제한을 넘어 올리지 못했습니다.',
  IMAGE_MISSING: '본문 이미지 파일이 기기에 없어 올리지 못했습니다.',
  PROJECT_NOT_WRITABLE: '이 프로젝트에 노트를 만들 권한이 없습니다.',
};

/** 오프라인 작성 기한 표시: "10월 13일 14:05까지 (13일 남음)" */
export function deadlineLabel(tokenExpiresAt: string, now: number): { text: string; daysLeft: number; urgent: boolean } {
  const t = Date.parse(tokenExpiresAt);
  const ms = t - now;
  const daysLeft = Math.floor(ms / 86_400_000);
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const when = `${d.getMonth() + 1}월 ${d.getDate()}일 ${hh}:${mm}`;
  if (ms <= 0) return { text: `${when} 만료`, daysLeft: 0, urgent: true };
  const left = daysLeft >= 1 ? `${daysLeft}일 남음` : `${Math.max(1, Math.ceil(ms / 3_600_000))}시간 남음`;
  return { text: `${when}까지 (${left})`, daysLeft, urgent: ms < 2 * 86_400_000 };
}

export function relativeTime(iso: string | null | undefined, now: number): string {
  if (!iso) return '없음';
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}
