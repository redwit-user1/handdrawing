import { useSyncExternalStore } from 'react';
import { Network } from '@capacitor/network';
import { App as CapApp } from '@capacitor/app';
import { db } from './db.ts';
import { syncNow, type SyncResult } from './sync.ts';
import { pairingFromUrl } from './pairing.ts';
import { touchClock } from './session.ts';
import type { LocalNote, Meta, Session } from './types.ts';

/** 화면이 구독하는 앱 상태 (저장소의 사본) */
export interface NoteCounts { pending: number; rejected: number; sent: number }
export interface AppState {
  loaded: boolean;
  session: Session | null;
  meta: Meta | null;
  notes: LocalNote[];
  counts: Record<string, NoteCounts>;
  online: boolean;
  syncing: boolean;
  lastResult: SyncResult | null;
  /** 화면 갱신용 현재 시각 (10초마다) */
  now: number;
  /** 앱 밖에서 열린 `goono-note://pair` 링크 (id 는 새 링크마다 올라간다). 연결 화면이 받아 쓰거나, 쓸 수 없는 상황이면 App 이 비운다 */
  pairLink: { id: number; url: string } | null;
}

let state: AppState = {
  loaded: false, session: null, meta: null, notes: [], counts: {}, online: true, syncing: false, lastResult: null, now: Date.now(), pairLink: null,
};
const listeners = new Set<() => void>();

function set(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useApp(): AppState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}
export const getState = (): AppState => state;

let pairLinkSeq = 0;
/**
 * 딥링크 수신. `goono-note://pair` 가 아닌 URL 은 우리 것이 아니므로 무시한다.
 * http 서버 허용 여부는 화면(개발 빌드 여부)이 정하므로 여기서는 "우리 링크인가"만 가린다.
 */
export function openUrl(url: string): void {
  if (!pairingFromUrl(url, { allowHttp: true })) return;
  set({ pairLink: { id: ++pairLinkSeq, url } });
}
export function clearPairLink(): void {
  if (state.pairLink) set({ pairLink: null });
}

/** 저장소에서 다시 읽어 화면에 반영 */
export async function reload(): Promise<void> {
  const [session, meta, notes] = await Promise.all([db.getSession(), db.getMeta(), db.listNotes()]);
  const counts: Record<string, NoteCounts> = {};
  for (const n of notes) {
    const vs = await db.listVersions(n.id);
    counts[n.id] = {
      pending: vs.filter((v) => v.state === 'PENDING').length,
      rejected: vs.filter((v) => v.state === 'REJECTED').length,
      sent: vs.filter((v) => v.state === 'SENT').length,
    };
  }
  notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  set({ loaded: true, session, meta, notes, counts, now: Date.now() });
}

/** 동기화 (온라인·로그인 상태일 때만). 끝나면 화면 갱신 */
export async function sync(): Promise<SyncResult | null> {
  if (!state.session || !state.online) return null;
  set({ syncing: true });
  try {
    const r = await syncNow();
    set({ lastResult: r });
    return r;
  } finally {
    await reload();
    set({ syncing: false });
  }
}

let started = false;
const SYNC_INTERVAL_MS = 60_000;

/** 앱 시작: 저장소 읽기, 네트워크 감시, 주기 동기화 */
export async function start(): Promise<void> {
  if (started) return;
  started = true;
  try {
    const s = await Network.getStatus();
    set({ online: s.connected });
  } catch { /* 웹 */ }
  await Network.addListener('networkStatusChange', (s) => {
    set({ online: s.connected });
    if (s.connected) void sync();
  });
  await CapApp.addListener('resume', () => { void touchClock().then(reload).then(sync); });
  await CapApp.addListener('appUrlOpen', (e) => openUrl(e.url));

  await reload();
  if (state.session) {
    await touchClock();
    await reload();
    void sync();
  }
  setInterval(() => {
    set({ now: Date.now() });
    void touchClock();
  }, 10_000);
  setInterval(() => { if (!state.syncing) void sync(); }, SYNC_INTERVAL_MS);
}
