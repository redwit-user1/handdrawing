import { useEffect, type ReactNode } from 'react';
import { sync, useApp, type NoteCounts } from './lib/store.ts';
import { deadlineLabel, relativeTime, sessionLock, LOCK_MESSAGES } from './lib/rules.ts';
import type { LocalNote } from './lib/types.ts';
import { IcLock, IcSync } from './icons.tsx';

export function Dialog({ title, children, onClose, testId, wide }: { title: string; children: ReactNode; onClose: () => void; testId?: string; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} data-testid={testId} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** 온라인 상태 · 올릴 기록 · 마지막 동기화 · 오프라인 작성 기한 · 지금 동기화 */
export function SyncBar() {
  const { session, online, syncing, lastResult, counts, now } = useApp();
  if (!session) return null;
  const pending = Object.values(counts).reduce((n, c) => n + c.pending, 0);
  const lock = sessionLock(session, now);
  const deadline = deadlineLabel(session.tokenExpiresAt, now);
  return (
    <div className="syncbar" data-testid="syncbar" data-online={online} data-pending={pending}>
      <span className={`dot ${online ? 'on' : 'off'}`} />
      <span data-testid="net-state">{online ? '온라인' : '오프라인'}</span>
      <span className="sep" />
      <span data-testid="pending-count">{pending ? `올릴 버전 ${pending}개` : '모두 올림'}</span>
      <span className="sep" />
      <span>마지막 동기화 {relativeTime(session.lastSyncAt, now)}</span>
      <span className="sep" />
      <span className={deadline.urgent ? 'warn' : ''} data-testid="deadline">오프라인 작성 기한 {deadline.text}</span>
      {lastResult && !lastResult.ok && lastResult.error && !lastResult.offline && (
        <span className="warn" data-testid="sync-error">· {lastResult.error}</span>
      )}
      <button className="btn small" disabled={!online || syncing || lock === 'REVOKED' || lock === 'NEEDS_LOGIN'} onClick={() => void sync()} data-testid="sync-now">
        <IcSync /> {syncing ? '동기화 중…' : '지금 동기화'}
      </button>
    </div>
  );
}

export function LockBanner({ onRelogin }: { onRelogin?: () => void }) {
  const { session, now } = useApp();
  if (!session) return null;
  const lock = sessionLock(session, now);
  if (!lock) return null;
  return (
    <div className="banner danger" data-testid="lock-banner" data-lock={lock}>
      <IcLock /> <span className="grow">{LOCK_MESSAGES[lock]}</span>
      {lock === 'NEEDS_LOGIN' && onRelogin && <button className="btn small" onClick={onRelogin}>다시 로그인</button>}
    </div>
  );
}

export type Chip = { label: string; tone: 'ok' | 'info' | 'warn' | 'danger' | 'muted' };

export function noteChips(n: LocalNote, c: NoteCounts | undefined): Chip[] {
  const chips: Chip[] = [];
  if (n.serverStatus === 'INSPECTION') chips.push({ label: '점검 중', tone: 'info' });
  else if (n.serverStatus === 'COMPLETE') chips.push({ label: '점검 완료', tone: 'ok' });
  else if (n.serverStatus === 'REJECT') chips.push({ label: '반려됨', tone: 'warn' });

  if (n.released) chips.push({ label: '웹으로 넘김', tone: 'muted' });
  else if (n.releaseRequested) chips.push({ label: '작성 완료 대기', tone: 'info' });
  else if (n.reclaimed || n.editLocation !== 'THIS_DEVICE') chips.push({ label: '편집권 회수됨', tone: 'danger' });
  else chips.push({ label: '이 기기에서 작성 중', tone: 'ok' });

  if (n.noteMno == null) chips.push({ label: '서버 미등록', tone: 'muted' });
  if (c?.pending) chips.push({ label: `올릴 버전 ${c.pending}`, tone: 'warn' });
  if (c?.rejected) chips.push({ label: `미반영 ${c.rejected}`, tone: 'danger' });
  return chips;
}

export function Chips({ chips }: { chips: Chip[] }) {
  return <span className="chips">{chips.map((c) => <span key={c.label} className={`chip ${c.tone}`}>{c.label}</span>)}</span>;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
