import { useEffect, useState } from 'react';
import { db } from '../lib/db.ts';
import { restoreAsNewNote } from '../lib/notes.ts';
import type { LocalVersion } from '../lib/types.ts';
import { docFromHtml } from '../notebook/render.ts';
import { previewHtml, sanitize } from '../notebook/preview.ts';
import { IcClose } from '../icons.tsx';
import { Dialog, fmtDateTime } from '../ui.tsx';
import { NewNoteDialog } from './Notes.tsx';

const STATE_LABEL: Record<LocalVersion['state'], string> = { PENDING: '올릴 예정', SENT: '구노에 올라감', REJECTED: '미반영' };

function Preview({ version, onClose }: { version: LocalVersion; onClose: () => void }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    let revoke = () => {};
    void previewHtml(version.html).then((r) => { revoke = r.revoke; setHtml(sanitize(r.html)); });
    return () => revoke();
  }, [version]);
  return (
    <Dialog title={`버전 ${version.seq} 보기`} onClose={onClose} testId="preview-dialog" wide>
      <div className="preview" dangerouslySetInnerHTML={{ __html: html || '<p class="muted">내용이 없는 버전입니다.</p>' }} />
      <div className="row end"><button className="btn" onClick={onClose}>닫기</button></div>
    </Dialog>
  );
}

/**
 * 버전 기록 — 구노로 올라가는 단위. 노트를 떠날 때·앱을 내릴 때·5분마다 저절로 생기고,
 * 여기서 바로 만들 수도 있다. 서버가 받지 않은 버전은 "미반영"으로 남기고 새 노트로 복원할 수 있다.
 */
export default function Versions({ noteId, noteTitle, canCreate, onCreate, onClose, onRestored, refreshKey }: {
  noteId: string;
  noteTitle: string;
  canCreate: boolean;
  onCreate: () => Promise<void>;
  onClose: () => void;
  onRestored: (id: string) => void;
  refreshKey: number;
}) {
  const [list, setList] = useState<LocalVersion[] | null>(null);
  const [preview, setPreview] = useState<LocalVersion | null>(null);
  const [restoring, setRestoring] = useState<LocalVersion | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void db.listVersions(noteId).then((v) => setList([...v].reverse())); }, [noteId, refreshKey]);

  const restoreDoc = restoring ? docFromHtml(restoring.html) : null;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" aria-label="버전 기록" data-testid="versions-panel">
        <div className="drawer-head">
          <h2>버전 기록</h2>
          <button className="icon-btn" onClick={onClose} aria-label="닫기"><IcClose /></button>
        </div>
        <p className="muted small">버전은 구노에 올라가는 단위입니다. 노트를 떠날 때, 앱을 내릴 때, 5분마다 저절로 만들어집니다.
          구노 웹의 수정 이력에는 서버가 받은 시각이 남습니다.</p>
        <button className="btn block" disabled={!canCreate || busy} data-testid="save-version"
          onClick={async () => { setBusy(true); try { await onCreate(); } finally { setBusy(false); } }}>
          {busy ? '만드는 중…' : '지금 버전 만들기'}
        </button>
        {!list ? <p className="muted">불러오는 중…</p> : !list.length ? <p className="muted empty-small">아직 버전이 없습니다. 쓰기 시작하면 저절로 만들어집니다.</p> : (
          <ol className="version-list">
            {list.map((v) => (
              <li key={v.id} className={`version ${v.state.toLowerCase()}`} data-testid="version-item" data-state={v.state}>
                <div className="version-head">
                  <b>버전 {v.seq}</b>
                  {v.autoSave && <span className="muted small">자동</span>}
                  <span className={`chip ${v.state === 'SENT' ? 'ok' : v.state === 'PENDING' ? 'warn' : 'danger'}`}>{STATE_LABEL[v.state]}</span>
                </div>
                <dl className="version-meta">
                  <dt>기기에서 씀</dt><dd>{fmtDateTime(v.deviceWrittenAt)}</dd>
                  {v.state === 'SENT' && <><dt>구노가 받음</dt><dd>{fmtDateTime(v.receivedAt)} · 구노 버전 {v.serverVersionId}</dd></>}
                  <dt>페이지</dt><dd>{v.imageRefs.length}쪽</dd>
                </dl>
                {v.state === 'REJECTED' && <p className="small danger-text">{v.rejectMessage}</p>}
                {v.state === 'PENDING' && v.lastError && <p className="small warn-text">다시 시도합니다: {v.lastError}</p>}
                <div className="row end">
                  <button className="btn small" onClick={() => setPreview(v)} data-testid="version-view">보기</button>
                  {v.state === 'REJECTED' && docFromHtml(v.html) && (
                    <button className="btn small primary" onClick={() => setRestoring(v)} data-testid="version-restore">새 노트로 복원</button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </aside>
      {preview && <Preview version={preview} onClose={() => setPreview(null)} />}
      {restoring && restoreDoc && (
        <NewNoteDialog
          heading="미반영 버전을 새 노트로 복원"
          initialTitle={`${noteTitle} (복원)`}
          submitLabel="복원"
          create={(p, title) => restoreAsNewNote(restoreDoc, p, title)}
          onClose={() => setRestoring(null)}
          onCreated={(id) => { setRestoring(null); onRestored(id); }}
        />
      )}
    </>
  );
}
