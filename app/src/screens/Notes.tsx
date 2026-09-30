import { useState } from 'react';
import { createNote, defaultTitle } from '../lib/notes.ts';
import { logout } from '../lib/session.ts';
import { isDemoServer } from '../lib/demo.ts';
import { reload, sync, useApp } from '../lib/store.ts';
import { relativeTime, sessionLock } from '../lib/rules.ts';
import type { Project } from '../lib/types.ts';
import { IcPen, IcPlus } from '../icons.tsx';
import { Chips, Dialog, LockBanner, noteChips, SyncBar } from '../ui.tsx';

const LAST_PROJECT = 'goono-note.last-project';

/** 프로젝트를 고르고 바로 쓰기 시작 — 제목은 날짜로 채워 두고 나중에 고친다 */
export function NewNoteDialog({ onClose, onCreated, initialTitle, create = createNote, heading = '새 노트', submitLabel = '쓰기 시작' }: {
  onClose: () => void;
  onCreated: (id: string) => void;
  initialTitle?: string;
  create?: (p: Project, title: string) => Promise<{ id: string }>;
  heading?: string;
  submitLabel?: string;
}) {
  const { meta } = useApp();
  const projects = (meta?.projects ?? []).filter((p) => p.writable);
  const last = Number(localStorage.getItem(LAST_PROJECT));
  const [projectMno, setProjectMno] = useState<number | null>(projects.some((p) => p.projectMno === last) ? last : null);
  const [title, setTitle] = useState(initialTitle ?? '');
  const [busy, setBusy] = useState(false);
  const selected = projects.find((p) => p.projectMno === projectMno) ?? projects[0];

  const submit = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      localStorage.setItem(LAST_PROJECT, String(selected.projectMno));
      const n = await create(selected, title);
      await reload();
      void sync();
      onCreated(n.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={heading} onClose={onClose} testId="new-note-dialog">
      {!projects.length ? (
        <p className="muted">쓸 수 있는 프로젝트가 없습니다. 인터넷에 연결해 한 번 동기화하면 프로젝트 목록을 받아 옵니다.</p>
      ) : (
        <>
          <fieldset className="project-pick">
            <legend>프로젝트</legend>
            {projects.map((p) => (
              <label key={p.projectMno} className={`project-opt${selected?.projectMno === p.projectMno ? ' active' : ''}`}>
                <input type="radio" name="project" checked={selected?.projectMno === p.projectMno} onChange={() => setProjectMno(p.projectMno)} data-testid="new-note-project" value={p.projectMno} />
                <span>{p.name}</span>
              </label>
            ))}
          </fieldset>
          <label className="field">제목 <span className="muted small">비워 두면 "{defaultTitle()}"</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={defaultTitle()} data-testid="new-note-title" />
          </label>
        </>
      )}
      <div className="row end">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary" disabled={busy || !projects.length} onClick={() => void submit()} data-testid="new-note-create">
          <IcPen /> {submitLabel}
        </button>
      </div>
    </Dialog>
  );
}

export default function Notes({ onOpen, onRelogin, onLoggedOut }: { onOpen: (id: string) => void; onRelogin: () => void; onLoggedOut: () => void }) {
  const { session, meta, notes, counts, now } = useApp();
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState('');
  if (!session) return null;
  const lock = sessionLock(session, now);
  const writable = (meta?.projects ?? []).filter((p) => p.writable);

  const startNew = async () => {
    // 쓸 수 있는 프로젝트가 하나뿐이면 묻지 않고 바로 연다
    if (writable.length === 1) {
      const n = await createNote(writable[0]);
      await reload();
      void sync();
      onOpen(n.id);
      return;
    }
    setCreating(true);
  };

  const doLogout = async () => {
    setMenu(false);
    try {
      await logout();
      await reload();
      onLoggedOut();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="screen">
      <header className="topbar">
        <h1>연구노트</h1>
        {isDemoServer(session.serverUrl) && <span className="chip info" data-testid="demo-chip">체험 모드</span>}
        <span className="grow" />
        <div className="pal-anchor">
          <button className="btn ghost" onClick={() => setMenu((v) => !v)} aria-expanded={menu} data-testid="user-menu">{session.user.name} · {session.deviceName}</button>
          {menu && (
            <div className="user-menu" role="menu">
              <div className="muted small">{session.serverUrl}</div>
              <button className="btn ghost block" role="menuitem" onClick={() => void doLogout()} data-testid="logout">
              {isDemoServer(session.serverUrl) ? '체험 끝내기 (기록 지움)' : '로그아웃'}
            </button>
            </div>
          )}
        </div>
        <button className="btn primary" disabled={!!lock} onClick={() => void startNew()} data-testid="new-note"><IcPlus /> 새 노트</button>
      </header>
      <SyncBar />
      <LockBanner onRelogin={onRelogin} />
      {error && <div className="banner danger" role="alert" onClick={() => setError('')}>{error}</div>}
      <main className="shelf">
        {!notes.length ? (
          <div className="empty" data-testid="empty">
            <div className="empty-page" aria-hidden="true"><IcPen /></div>
            <h2>첫 노트를 펜으로 시작하세요</h2>
            <p className="muted">새 노트를 만들면 모눈 페이지가 열리고 바로 쓸 수 있습니다. 인터넷이 없어도 됩니다.<br />연결되면 구노 전자연구노트에 올라갑니다.</p>
            <button className="btn primary" disabled={!!lock} onClick={() => void startNew()}><IcPlus /> 새 노트</button>
          </div>
        ) : (
          <ul className="note-grid" data-testid="note-list">
            {notes.map((n) => (
              <li key={n.id}>
                <button className="note-card" onClick={() => onOpen(n.id)} data-testid="note-card" data-note-id={n.id}>
                  <div className="thumb">{n.thumb ? <img src={n.thumb} alt="" /> : <span className="thumb-empty" />}</div>
                  <div className="note-card-body">
                    <div className="note-card-title">{n.title}</div>
                    <div className="muted small">{n.projectName} · {relativeTime(n.updatedAt, now)}</div>
                    <Chips chips={noteChips(n, counts[n.id])} />
                    {n.syncIssue && <div className="small warn-text">{n.syncIssue.message}</div>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
      {creating && <NewNoteDialog onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); onOpen(id); }} />}
    </div>
  );
}
