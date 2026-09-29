/** 서버 계약 (docs/SYNC-API.md) */
export type ServerStatus = 'WRITING' | 'INSPECTION' | 'COMPLETE' | 'REJECT';
export type EditLocation = { type: 'DEVICE'; deviceId: string } | { type: 'WEB' };

export interface User { userMno: number; loginId: string; name: string }
export interface Project { projectMno: number; name: string; writable: boolean }

export interface ServerNote {
  noteMno: number;
  clientNoteId: string;
  title: string;
  projectMno: number;
  status: ServerStatus;
  editLocation: EditLocation;
  latestVersionId: number | null;
  updatedAt: string;
}

/** 기기에 저장되는 세션 (암호화) */
export interface Session {
  serverUrl: string;
  deviceId: string;
  deviceName: string;
  token: string;
  /** = 오프라인 편집 허용 기한 */
  tokenExpiresAt: string;
  offlineGraceDays: number;
  user: User;
  lastServerContactAt: string;
  lastSyncAt?: string;
  /** 서버가 기기를 폐기함 → 편집 잠금 */
  revoked?: boolean;
  /** 토큰 만료로 다시 로그인해야 함 */
  needsLogin?: boolean;
  /** 기기에서 관측한 가장 늦은 시각(ms) — 시계를 되돌려 오프라인 기한을 늘리는 것을 막는다 */
  clockHighWater?: number;
}

export interface Meta {
  projects: Project[];
  maxImageBytes: number;
  fetchedAt: string;
}

/**
 * 기기의 노트. 편집 가능 여부는 서버 상태·편집 위치·세션 잠금으로 판단한다(canEdit).
 */
export interface LocalNote {
  id: string;                 // clientNoteId (기기가 만든 UUID)
  noteMno: number | null;     // 서버에 만들어지기 전에는 null
  projectMno: number;
  projectName: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  serverStatus: ServerStatus | null;
  editLocation: 'THIS_DEVICE' | 'WEB';
  /** 이 기기가 "작성 완료"로 편집권을 넘김 */
  released: boolean;
  /** "작성 완료"를 눌렀으나 아직 서버에 반영 전(오프라인) — 다음 동기화 때 버전을 모두 올린 뒤 반납 */
  releaseRequested: boolean;
  /** 서버에서 편집권이 회수됨 (분실 기기 처리 등) */
  reclaimed: boolean;
  latestServerVersionId: number | null;
  versionSeq: number;
  workingSavedAt: string | null;
  /** 마지막 버전 이후 작업본이 바뀌었는지 */
  workingDirty: boolean;
  /** 동기화 중 노트 단위로 생긴 문제 (예: 프로젝트 권한 없음, 서버 버전 불일치) */
  syncIssue?: { code: string; message: string; at: string } | null;
}

export type VersionState = 'PENDING' | 'SENT' | 'REJECTED';

export interface LocalVersion {
  id: string;               // clientVersionId
  noteId: string;
  seq: number;
  deviceWrittenAt: string;
  autoSave: boolean;
  /** 저장 형식 HTML — 이미지는 src="hdimg:{ref}" */
  html: string;
  imageRefs: string[];
  contentHash: string;
  state: VersionState;
  serverVersionId?: number;
  receivedAt?: string;
  rejectCode?: string;
  rejectMessage?: string;
  attempts?: number;
  lastError?: string;
}

export interface ImageMeta { mime: string; size: number; noteId: string }
