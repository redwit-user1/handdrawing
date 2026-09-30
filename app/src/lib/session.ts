import { Device } from '@capacitor/device';
import { api, normalizeServerUrl } from './api.ts';
import { isDemoServer, resetDemo } from './demo.ts';
import { secureGet, secureSet, uuid } from './crypto.ts';
import { db } from './db.ts';
import type { Session } from './types.ts';

export const APP_VERSION = '0.1.0';
const DEVICE_ID_KEY = 'goono-note.device-id.v1';

/** 기기 ID — 앱 설치마다 한 번 만들어 보안 저장소에 둔다(로그아웃해도 유지) */
export async function deviceId(): Promise<string> {
  let id = await secureGet(DEVICE_ID_KEY);
  if (!id) {
    id = uuid();
    await secureSet(DEVICE_ID_KEY, id);
  }
  return id;
}

export async function defaultDeviceName(): Promise<string> {
  try {
    const info = await Device.getInfo();
    if (info.name) return info.name;
    if (info.platform === 'ios') return `iPad (${info.model})`;
    if (info.platform === 'android') return `${info.manufacturer} ${info.model}`.trim();
  } catch { /* 웹 */ }
  return '태블릿';
}

export async function hasUnsentWork(): Promise<boolean> {
  for (const n of await db.listNotes()) {
    if (n.workingDirty || n.releaseRequested) return true;
    if ((await db.listVersions(n.id)).some((v) => v.state === 'PENDING')) return true;
  }
  return false;
}

/**
 * 로그인(기기 등록). 같은 사용자의 재로그인이면 기기 데이터를 그대로 이어 쓰고,
 * 다른 사용자라면 앞 사용자의 미전송 기록이 없을 때만 기기 데이터를 비우고 시작한다.
 */
export async function login(serverUrl: string, loginId: string, password: string, deviceName: string): Promise<Session> {
  const url = normalizeServerUrl(serverUrl);
  const id = await deviceId();
  let platform = 'web';
  let model = 'browser';
  try {
    const info = await Device.getInfo();
    platform = info.platform;
    model = info.model;
  } catch { /* 웹 */ }

  const prev = await db.getSession();
  const r = await api.register(url, loginId, password, { id, name: deviceName, platform, model, appVersion: APP_VERSION });

  if (prev && (prev.user.userMno !== r.user.userMno || prev.serverUrl !== url)) {
    if (await hasUnsentWork()) {
      throw new Error(`이 기기에 ${prev.user.name}(${prev.user.loginId}) 님의 올리지 않은 기록이 있습니다. 그 계정으로 로그인해 동기화한 뒤 로그아웃하세요.`);
    }
    await db.wipe();
  }
  const now = new Date().toISOString();
  const session: Session = {
    serverUrl: url,
    deviceId: id,
    deviceName,
    token: r.token,
    tokenExpiresAt: r.tokenExpiresAt,
    offlineGraceDays: r.offlineGraceDays,
    user: r.user,
    lastServerContactAt: now,
    lastSyncAt: prev?.user.userMno === r.user.userMno ? prev.lastSyncAt : undefined,
    revoked: false,
    needsLogin: false,
    clockHighWater: Date.now(),
  };
  await db.putSession(session);
  return session;
}

/** 로그아웃 — 올리지 않은 기록이 있으면 거부한다. 기기 데이터는 모두 지운다 */
export async function logout(): Promise<void> {
  const s = await db.getSession();
  if (await hasUnsentWork()) throw new Error('올리지 않은 기록이 있습니다. 동기화한 뒤 로그아웃하세요.');
  await db.wipe();
  if (s && isDemoServer(s.serverUrl)) resetDemo();
}

/** 시계 되돌림 감지용 최고 시각 갱신 */
export async function touchClock(): Promise<void> {
  const now = Date.now();
  await db.updateSession((s) => (s.clockHighWater != null && s.clockHighWater >= now ? s : { ...s, clockHighWater: now }));
}
