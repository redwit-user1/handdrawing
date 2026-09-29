import { useCallback, useEffect, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import { EditorSession, previewHtml } from '../editor/host.ts';
import { db } from '../lib/db.ts';
import { createVersion, requestRelease, restoreAsNewNote } from '../lib/notes.ts';
import { editBlock } from '../lib/rules.ts';
import { reload, sync, useApp } from '../lib/store.ts';
import type { LocalVersion } from '../lib/types.ts';
import { Chips, Dialog, fmtDateTime, LockBanner, noteChips, SyncBar } from '../ui.tsx';
import { NewNoteDialog } from './Notes.tsx';

const AUTO_VERSION_MS = 5 * 60_000;

/** 본문 미리보기용 최소 정리 (스크립트·이벤트 속성 제거) */
function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('script, iframe, object, embed, link, meta, style').forEach((el) => el.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
  });
  return doc.body.innerHTML;
}

function Preview({ version, onClose }: { version: LocalVersion; onClose: () => void }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    let revoke = () => {};
    void previewHtml(version.html).then((r) => { revoke = r.revoke; setHtml(sanitize(r.html)); });
    return () => revoke();
  }, [version]);
  return (
    <Dialog title={`기록 #${version.seq} 보기`} onClose={onClose} testId="preview-dialog">
      <div className="preview rw-editor-content" dangerouslySetInnerHTML={{ __html: html }} />
      <div className="row end"><button className="btn" onClick={onClose}>닫기</button></div>
    </Dialog>
  );
}

const STATE_LABEL: Record<LocalVersion['state'], string> = { PENDING: '올릴 예정', SENT: '구노에 올라감', REJECTED: '미반영' };

function Versions({ noteId, noteTitle, onClose, onRestored }: { noteId: string; noteTitle: string; onClose: () => void; onRestored: (id: string) => void }) {
  const [list, setList] = useState<LocalVersion[] | null>(null);
  const [preview, setPreview] = useState<LocalVersion | null>(null);
  const [restoring, setRestoring] = useState<LocalVersion | null>(null);
  useEffect(() => { void db.listVersions(noteId).then((v) => setList([...v].reverse())); }, [noteId]);

  return (
    <div className="drawer" data-testid="versions-panel">
      <div className="row">
        <h2 className="grow">기록</h2>
        <button className="btn" onClick={onClose}>닫기</button>
      </div>
      <p className="muted small">버전은 구노에 올라가는 단위입니다. 올라간 버전은 구노 웹의 수정 이력에 서버 수신 시각과 함께 남고,
        서버가 받지 않은 버전은 "미반영"으로 이 기기에 보관됩니다.</p>
      {!list ? <p className="muted">불러오는 중…</p> : !list.length ? <p className="muted">아직 버전이 없습니다.</p> : (
        <ul className="version-list">
          {list.map((v) => (
            <li key={v.id} className={`version ${v.state.toLowerCase()}`} data-testid="version-item" data-state={v.state}>
              <div className="row">
                <b className="grow">#{v.seq} {v.autoSave ? '(자동)' : ''}</b>
                <span className={`chip ${v.state === 'SENT' ? 'ok' : v.state === 'PENDING' ? 'warn' : 'danger'}`}>{STATE_LABEL[v.state]}</span>
              </div>
              <div className="small muted">기기 작성 {fmtDateTime(v.deviceWrittenAt)}
                {v.state === 'SENT' && <> · 서버 수신 {fmtDateTime(v.receivedAt)} · 구노 버전 {v.serverVersionId}</>}
                {v.imageRefs.length > 0 && <> · 이미지 {v.imageRefs.length}</>}
              </div>
              {v.state === 'REJECTED' && <div className="small warn">{v.rejectMessage}</div>}
              {v.state === 'PENDING' && v.lastError && <div className="small warn">재시도 예정: {v.lastError}</div>}
              <div className="row end">
                <button className="btn small" onClick={() => setPreview(v)} data-testid="version-view">보기</button>
                {v.state === 'REJECTED' && <button className="btn small primary" onClick={() => setRestoring(v)} data-testid="version-restore">새 노트로 복원</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {preview && <Preview version={preview} onClose={() => setPreview(null)} />}
      {restoring && (
        <NewNoteDialog
          heading="미반영 기록을 새 노트로 복원"
          initialTitle={`${noteTitle} (복원)`}
          create={(p, title) => restoreAsNewNote(restoring, p, title)}
          onClose={() => setRestoring(null)}
          onCreated={(id) => { setRestoring(null); onRestored(id); }}
        />
      )}
    </div>
  );
}

export default function Note({ id, onBack, onOpen, onRelogin }: { id: string; onBack: () => void; onOpen: (id: string) => void; onRelogin: () => void }) {
  const { session, meta, notes, counts, now, online } = useApp();
  const note = notes.find((n) => n.id === id) ?? null;
  const block = note && session ? editBlock(note, session, now) : null;
  const readOnly = !!block;
  const editorRef = useRef<EditorSession | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(note?.workingSavedAt ?? null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState('');
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [busy, setBusy] = useState(false);
  const elementId = `note-editor-${id}`;

  const say = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? '' : t)), 4000);
  }, []);

  // 편집기 열기/닫기 (노트가 바뀔 때만)
  useEffect(() => {
    const s = new EditorSession({
      elementId, noteId: id, readOnly, maxImageBytes: meta?.maxImageBytes ?? 50 * 1024 * 1024,
      onSaved: () => setSavedAt(new Date().toISOString()),
      onError: (m) => say(m),
    });
    editorRef.current = s;
    setLoading(true);
    s.open().then(() => setLoading(false), (e) => { setLoading(false); say(`편집기를 열 수 없습니다: ${(e as Error).message}`); });
    return () => {
      editorRef.current = null;
      // 떠날 때: 작업본 저장 → 바뀐 게 있으면 자동 버전 → 동기화
      void s.destroy().then(() => createVersion(id, true)).then(() => reload()).then(() => sync());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => { editorRef.current?.setReadOnly(readOnly); }, [readOnly]);

  const autoVersion = useCallback(async () => {
    const s = editorRef.current;
    if (!s) return;
    await s.flush();
    const v = await createVersion(id, true);
    if (v) { await reload(); void sync(); }
  }, [id]);

  // 앱이 백그라운드로 갈 때·5분마다 자동 버전
  useEffect(() => {
    const timer = window.setInterval(() => void autoVersion(), AUTO_VERSION_MS);
    const onHidden = () => { if (document.visibilityState === 'hidden') void autoVersion(); };
    document.addEventListener('visibilitychange', onHidden);
    const sub = CapApp.addListener('pause', () => void autoVersion());
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onHidden);
      void sub.then((h) => h.remove());
    };
  }, [autoVersion]);

  if (!note || !session) return <div className="screen"><p className="muted">노트를 찾을 수 없습니다.</p><button className="btn" onClick={onBack}>목록</button></div>;

  const saveVersion = async () => {
    setBusy(true);
    try {
      await editorRef.current?.flush();
      const v = await createVersion(id, false);
      await reload();
      if (!v) { say('바뀐 내용이 없습니다.'); return; }
      const r = online ? await sync() : null;
      say(r?.ok && r.sent ? `버전 #${v.seq}을(를) 구노에 올렸습니다.` : `버전 #${v.seq}을(를) 기기에 저장했습니다. 연결되면 구노에 올립니다.`);
    } finally {
      setBusy(false);
    }
  };

  const release = async () => {
    setConfirmRelease(false);
    setBusy(true);
    try {
      await editorRef.current?.flush();
      await requestRelease(id);
      await reload();
      const r = online ? await sync() : null;
      const fresh = (await db.getNote(id));
      if (fresh?.released) say('구노 웹으로 넘겼습니다. 구노 웹에서 점검 요청을 하세요.');
      else if (fresh?.syncIssue) say(`작성 완료하지 못했습니다: ${fresh.syncIssue.message}`);
      else say(r?.offline || !online ? '작성 완료로 표시했습니다. 연결되면 모든 기록을 올리고 웹으로 넘깁니다.' : '작성 완료 처리 중입니다.');
    } finally {
      setBusy(false);
    }
  };

  const c = counts[id];
  return (
    <div className="screen note-screen">
      <header className="topbar">
        <button className="btn ghost" onClick={onBack} data-testid="back">‹ 목록</button>
        <div className="grow title-block">
          <div className="note-title" data-testid="note-title">{note.title}</div>
          <div className="muted small">{note.projectName}{note.noteMno != null ? ` · #${note.noteMno}` : ''} · <Chips chips={noteChips(note, c)} /></div>
        </div>
        <span className="muted small" data-testid="saved-state">{readOnly ? '읽기 전용' : savedAt ? `기기에 저장됨 ${fmtDateTime(savedAt).slice(11)}` : '새 노트'}</span>
        <button className="btn" onClick={() => setShowVersions(true)} data-testid="open-versions">기록{c?.rejected ? ` · 미반영 ${c.rejected}` : ''}</button>
        <button className="btn" disabled={readOnly || busy} onClick={() => void saveVersion()} data-testid="save-version">버전 저장</button>
        <button className="btn primary" disabled={readOnly || busy} onClick={() => setConfirmRelease(true)} data-testid="release">작성 완료</button>
      </header>
      <SyncBar />
      <LockBanner onRelogin={onRelogin} />
      {block && block.kind !== 'LOCK' && <div className="banner info" data-testid="block-banner" data-kind={block.kind}>{block.message}</div>}
      {loading && <div className="muted center">편집기를 여는 중…</div>}
      <div className="editor-wrap"><div id={elementId} className="editor-host" data-testid="editor-host" /></div>
      {toast && <div className="toast" data-testid="toast">{toast}</div>}
      {confirmRelease && (
        <Dialog title="작성 완료" onClose={() => setConfirmRelease(false)} testId="release-dialog">
          <p>이 노트의 모든 기록을 구노에 올리고 편집권을 구노 웹으로 넘깁니다.</p>
          <ul className="small">
            <li>이후 이 기기에서는 수정할 수 없습니다(읽기 전용).</li>
            <li>점검 요청은 구노 웹에서 합니다. 시점인증은 점검 시 수행됩니다.</li>
            <li>오프라인이면 연결되는 대로 처리합니다.</li>
          </ul>
          <div className="row end">
            <button className="btn" onClick={() => setConfirmRelease(false)}>취소</button>
            <button className="btn primary" onClick={() => void release()} data-testid="release-confirm">작성 완료</button>
          </div>
        </Dialog>
      )}
      {showVersions && <Versions noteId={id} noteTitle={note.title} onClose={() => setShowVersions(false)} onRestored={(nid) => { setShowVersions(false); onOpen(nid); }} />}
    </div>
  );
}
