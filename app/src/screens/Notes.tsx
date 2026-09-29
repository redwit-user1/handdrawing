import { useState } from 'react';
import { createNote } from '../lib/notes.ts';
import { logout } from '../lib/session.ts';
import { reload, sync, useApp } from '../lib/store.ts';
import { relativeTime, sessionLock } from '../lib/rules.ts';
import type { Project } from '../lib/types.ts';
import { Chips, Dialog, LockBanner, noteChips, SyncBar } from '../ui.tsx';

export function NewNoteDialog({ onClose, onCreated, initialTitle = '', create = createNote, heading = '새 연구노트' }: {
  onClose: () => void;
  onCreated: (id: string) => void;
  initialTitle?: string;
  create?: (p: Project, title: string) => Promise<{ id: string }>;
  heading?: string;
}) {
  const { meta } = useApp();
  const projects = (meta?.projects ?? []).filter((p) => p.writable);
  const [projectMno, setProjectMno] = useState<number | ''>(projects[0]?.projectMno ?? '');
  const [title, setTitle] = useState(initialTitle);
  const [busy, setBusy] = useState(false);

  // 대화상자를 연 뒤에 프로젝트 목록이 도착할 수 있다 — 고른 게 없으면 첫 프로젝트
  const selected = projects.find((x) => x.projectMno === projectMno) ?? projects[0];

  const submit = async () => {
    const p = selected;
    if (!p) return;
    setBusy(true);
    try {
      const n = await create(p, title);
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
        <p className="muted">작성 가능한 프로젝트가 없습니다. 인터넷에 연결해 한 번 동기화하면 프로젝트 목록을 받아 옵니다.</p>
      ) : (
        <>
          <label>프로젝트
            <select value={selected?.projectMno ?? ''} onChange={(e) => setProjectMno(Number(e.target.value))} data-testid="new-note-project">
              {projects.map((p) => <option key={p.projectMno} value={p.projectMno}>{p.name}</option>)}
            </select>
          </label>
          <label>제목
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 시료 A 600℃ 열처리 1차" data-testid="new-note-title" autoFocus />
          </label>
          <p className="muted small">노트는 이 기기에서 작성하고, 연결될 때 구노에 올라갑니다. 구노 웹에서는 작성 완료 전까지 읽기 전용입니다.</p>
        </>
      )}
      <div className="row end">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary" disabled={busy || !projects.length || !title.trim()} onClick={() => void submit()} data-testid="new-note-create">만들기</button>
      </div>
    </Dialog>
  );
}

export default function Notes({ onOpen, onRelogin, onLoggedOut }: { onOpen: (id: string) => void; onRelogin: () => void; onLoggedOut: () => void }) {
  const { session, notes, counts, now } = useApp();
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState('');
  if (!session) return null;
  const lock = sessionLock(session, now);

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
        <h1>구노 연구노트</h1>
        <span className="grow" />
        <button className="btn ghost" onClick={() => setMenu((v) => !v)} data-testid="user-menu">{session.user.name} · {session.deviceName} ▾</button>
        {menu && (
          <div className="menu" onMouseLeave={() => setMenu(false)}>
            <div className="muted small">{session.serverUrl}</div>
            <button className="btn ghost" onClick={() => void doLogout()} data-testid="logout">로그아웃</button>
          </div>
        )}
      </header>
      <SyncBar />
      <LockBanner onRelogin={onRelogin} />
      {error && <div className="banner danger" onClick={() => setError('')}>{error}</div>}
      <main className="notes">
        <div className="row">
          <h2 className="grow">노트</h2>
          <button className="btn primary" disabled={!!lock} onClick={() => setCreating(true)} data-testid="new-note">+ 새 노트</button>
        </div>
        {!notes.length && <p className="muted empty">아직 노트가 없습니다. 새 노트를 만들어 손글씨나 글로 기록하세요.</p>}
        <ul className="note-list" data-testid="note-list">
          {notes.map((n) => (
            <li key={n.id}>
              <button className="note-card" onClick={() => onOpen(n.id)} data-testid="note-card" data-note-id={n.id}>
                <div className="note-title">{n.title}</div>
                <div className="muted small">{n.projectName}{n.noteMno != null ? ` · #${n.noteMno}` : ''} · 수정 {relativeTime(n.updatedAt, now)}</div>
                <Chips chips={noteChips(n, counts[n.id])} />
                {n.syncIssue && <div className="warn small">{n.syncIssue.message}</div>}
              </button>
            </li>
          ))}
        </ul>
      </main>
      {creating && <NewNoteDialog onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); onOpen(id); }} />}
    </div>
  );
}
