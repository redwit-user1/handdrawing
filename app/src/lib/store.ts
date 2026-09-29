import { useSyncExternalStore } from 'react';
import { Network } from '@capacitor/network';
import { App as CapApp } from '@capacitor/app';
import { db } from './db.ts';
import { syncNow, type SyncResult } from './sync.ts';
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
}

let state: AppState = {
  loaded: false, session: null, meta: null, notes: [], counts: {}, online: true, syncing: false, lastResult: null, now: Date.now(),
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
