import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import { db } from '../lib/db.ts';
import { createVersion, getDoc, renameNote, requestRelease, saveWorking } from '../lib/notes.ts';
import { deadlineLabel, editBlock, relativeTime, sessionLock } from '../lib/rules.ts';
import { reload, sync, useApp } from '../lib/store.ts';
import { createEngine, headerFor, type Engine, type ImageObject, type NotebookDoc, type Stroke, type TableObject } from '../notebook/engine.ts';
import ToolPalette, { INK_COLORS, INK_SIZES, type InsertKind, type PaletteState } from '../notebook/ToolPalette.tsx';
import TableDialog, { type TableValue } from '../notebook/insert/TableDialog.tsx';
import FormulaDialog, { type FormulaKind } from '../notebook/insert/FormulaDialog.tsx';
import type { StructureResult } from '../notebook/insert/StructureSheet.tsx';
import { IcBack, IcCheck, IcCopy, IcEdit, IcHand, IcHistory, IcLock, IcSync, IcText, IcTrash } from '../icons.tsx';
import { Boundary, Dialog, fmtDateTime, LockBanner } from '../ui.tsx';
import Versions from './Versions.tsx';

// 구조식 편집기(Ketcher)는 크다 — 처음 열 때만 불러온다
const StructureSheet = lazy(() => import('../notebook/insert/StructureSheet.tsx'));

/** 넣기·고치기 대화상자 상태. target 이 있으면 그 객체를 고친다 */
type InsertState =
  | { kind: 'table'; target?: TableObject }
  | { kind: FormulaKind; target?: ImageObject }
  | { kind: 'chem'; target?: ImageObject };

const OBJECT_NAMES: Record<string, string> = { table: '표', math: '수식', ce: '화학식', chem: '구조식', text: '글상자', image: '사진' };
function objectName(s: Stroke | null): string {
  if (!s) return '';
  return OBJECT_NAMES[(s.kind as string) ?? s.tool] ?? '';
}
function editable(s: Stroke | null): boolean {
  return !!s && (s.tool === 'table' || s.tool === 'text' || (s.tool === 'image' && !!s.kind));
}

function toBase64Svg(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} (${days[d.getDay()]}) ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const AUTO_VERSION_MS = 5 * 60_000;
const SAVE_DEBOUNCE_MS = 800;
const TOUCH_PREF = 'goono-note.touch-draws';
const INK_PREF = 'goono-note.ink';

function loadPref<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function savePref(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* 저장 안 됨 */ }
}

/** 사진은 긴 변 1600px JPEG 로 줄여 노트에 넣는다 (페이지 이미지 해상도에 충분) */
async function downscale(file: File, maxDim = 1600): Promise<{ src: string; w: number; h: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('사진을 읽을 수 없습니다.'));
      i.src = url;
    });
    const k = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return { src: c.toDataURL('image/jpeg', 0.85), w: c.width, h: c.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

type SaveState = { kind: 'idle' | 'saving' | 'saved' | 'error'; at?: string; message?: string };

export default function Note({ id, onBack, onOpen, onRelogin }: { id: string; onBack: () => void; onOpen: (id: string) => void; onRelogin: () => void }) {
  const { session, notes, counts, now, online, syncing, lastResult } = useApp();
  const note = notes.find((n) => n.id === id) ?? null;
  const block = note && session ? editBlock(note, session, now) : null;
  const readOnly = !!block;

  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const docRef = useRef<NotebookDoc | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  const [loaded, setLoaded] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: 'idle', at: note?.workingSavedAt ?? undefined });
  const [pal, setPal] = useState<PaletteState>(() => ({
    tool: 'pen', shape: 'line', ...loadPref(INK_PREF, { color: INK_COLORS[0].value, size: INK_SIZES[1].value }),
    touchDraws: loadPref(TOUCH_PREF, false),
  }));
  const [history, setHistory] = useState({ undo: false, redo: false });
  const [hasSelection, setHasSelection] = useState(false);
  const [selObj, setSelObj] = useState<Stroke | null>(null);
  const [inserting, setInserting] = useState<InsertState | null>(null);
  const [orientation, setOrientation] = useState<'rail' | 'bar'>('rail');
  const [statusOpen, setStatusOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [versionsKey, setVersionsKey] = useState(0);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);

  const say = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? '' : t)), 4500);
  }, []);

  /** 지금 캔버스 상태를 작업본으로 저장 */
  const persist = useCallback(async (commitText = false) => {
    const engine = engineRef.current;
    const doc = docRef.current;
    if (!engine || !doc || readOnlyRef.current) return;
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (commitText) engine.commitText();
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    const next: NotebookDoc = { ...doc, layout: engine.layout ?? doc.layout, strokes: engine.strokes };
    docRef.current = next;
    try {
      const at = await saveWorking(id, next);
      setSave({ kind: 'saved', at });
    } catch (e) {
      dirtyRef.current = true;
      setSave({ kind: 'error', message: (e as Error).message });
    }
  }, [id]);

  // ── 엔진 준비 (노트마다 한 번) ──
  useEffect(() => {
    const canvas = canvasRef.current!;
    const engine = createEngine(canvas, {
      onChange(userEdit) {
        setHistory({ undo: engine.undoStack.length > 0, redo: engine.redoStack.length > 0 });
        setEmpty(engine.strokes.length === 0);
        if (!userEdit || readOnlyRef.current) return;
        dirtyRef.current = true;
        setSave({ kind: 'saving' });
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => void persist(), SAVE_DEBOUNCE_MS);
      },
      onPenDetected() {
        // 펜이 닿으면 손가락은 넘기기로 (손바닥 오입력 방지)
        engine.touchDraws = false;
        setPal((p) => (p.touchDraws ? { ...p, touchDraws: false } : p));
        savePref(TOUCH_PREF, false);
      },
      onSelection(sel) {
        setHasSelection(!!sel);
        const picked = engine.selectedStrokes();
        setSelObj(picked.length === 1 ? picked[0] : null);
      },
    });
    engineRef.current = engine;
    // 진단·E2E 용 (기기 안에서만 보인다)
    (window as unknown as { __engine?: Engine }).__engine = engine;
    let cancelled = false;
    void (async () => {
      const doc = await getDoc(id);
      if (cancelled) return;
      docRef.current = doc;
      const n = (await db.getNote(id))!;
      engine.pageHeader = headerFor(n.title, n.createdAt);
      engine.setLayout(doc.layout);
      engine.setStrokes(JSON.parse(JSON.stringify(doc.strokes)));
      setEmpty(doc.strokes.length === 0);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
      engineRef.current = null;
      // 떠날 때: 작업본 저장 → 바뀐 게 있으면 자동 버전 → 동기화
      void (async () => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        engine.commitText();
        if (dirtyRef.current && docRef.current && !readOnlyRef.current) {
          dirtyRef.current = false;
          await saveWorking(id, { ...docRef.current, strokes: engine.strokes });
        }
        await createVersion(id, true);
        await reload();
        void sync();
      })();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // 도구 상태 → 엔진
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    e.tool = pal.tool;
    e.shape = pal.shape;
    e.color = pal.color;
    e.size = pal.size;
    e.touchDraws = pal.touchDraws;
    if (pal.tool !== 'lasso') e.clearSelection();
    e.requestRender();
    savePref(INK_PREF, { color: pal.color, size: pal.size });
    savePref(TOUCH_PREF, pal.touchDraws);
  }, [pal, loaded]);

  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    e.readonly = readOnly;
    if (readOnly) { e.commitText(); e.clearSelection(); }
    e.requestRender(true);
  }, [readOnly, loaded]);

  // 화면 크기·방향 → 캔버스 크기, 팔레트 위치, 엔진 여백
  useEffect(() => {
    const host = hostRef.current!;
    const apply = () => {
      const r = host.getBoundingClientRect();
      const o = r.height > r.width ? 'bar' : 'rail';
      setOrientation(o);
      const e = engineRef.current;
      if (!e) return;
      e.insets = o === 'rail' ? { top: 0, right: 0, bottom: 0, left: readOnlyRef.current ? 0 : 84 } : { top: 0, right: 0, bottom: readOnlyRef.current ? 0 : 88, left: 0 };
      e.resize();
    };
    const ro = new ResizeObserver(apply);
    ro.observe(host);
    apply();
    return () => ro.disconnect();
  }, [loaded, readOnly]);

  // 처음 열 때 페이지 폭 맞춤
  useEffect(() => { if (loaded) engineRef.current?.fitWidth(); }, [loaded, orientation]);

  const autoVersion = useCallback(async () => {
    await persist(true);
    const v = await createVersion(id, true);
    if (v) { await reload(); setVersionsKey((k) => k + 1); void sync(); }
  }, [id, persist]);

  // 앱이 백그라운드로 갈 때·5분마다: 작업본 저장 + 자동 버전
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

  if (!note || !session) {
    return <div className="screen center-screen"><p className="muted">노트를 찾을 수 없습니다.</p><button className="btn" onClick={onBack}>목록으로</button></div>;
  }

  const c = counts[id];
  const lock = sessionLock(session, now);
  const deadline = deadlineLabel(session.tokenExpiresAt, now);

  const makeVersion = async () => {
    setBusy(true);
    try {
      await persist(true);
      const v = await createVersion(id, false);
      await reload();
      setVersionsKey((k) => k + 1);
      if (!v) { say('바뀐 내용이 없어 새 버전을 만들지 않았습니다.'); return; }
      const r = online ? await sync() : null;
      setVersionsKey((k) => k + 1);
      say(r?.ok && r.sent ? `버전 ${v.seq}을 구노에 올렸습니다.` : `버전 ${v.seq}을 기기에 저장했습니다. 연결되면 구노에 올립니다.`);
    } finally {
      setBusy(false);
    }
  };

  const release = async () => {
    setConfirmRelease(false);
    setBusy(true);
    try {
      await persist(true);
      await requestRelease(id);
      await reload();
      const r = online ? await sync() : null;
      const fresh = await db.getNote(id);
      if (fresh?.released) say('구노 웹으로 넘겼습니다. 점검 요청은 구노 웹에서 하세요.');
      else if (fresh?.syncIssue) say(`작성 완료하지 못했습니다: ${fresh.syncIssue.message}`);
      else say(r?.offline || !online ? '작성 완료로 표시했습니다. 연결되면 모두 올리고 웹으로 넘깁니다.' : '작성 완료 처리 중입니다.');
    } finally {
      setBusy(false);
    }
  };

  const onPhoto = async (file: File) => {
    try {
      const { src, w, h } = await downscale(file);
      engineRef.current?.addImage(src, w, h);
      setPal((p) => ({ ...p, tool: 'lasso' })); // 넣은 사진을 바로 옮길 수 있게
    } catch (e) {
      say((e as Error).message);
    }
  };

  /** 넣은 객체를 바로 옮기고 고칠 수 있게 올가미로 */
  const afterInsert = () => setPal((p) => ({ ...p, tool: 'lasso' }));

  const onInsert = (kind: Exclude<InsertKind, 'photo'>) => {
    if (kind === 'stamp') {
      engineRef.current?.addTextBox(stamp());
      afterInsert();
      return;
    }
    setInserting({ kind } as InsertState);
  };

  const editSelected = () => {
    const s = selObj;
    const e = engineRef.current;
    if (!s || !e) return;
    if (s.tool === 'text') { setPal((p) => ({ ...p, tool: 'text' })); e.editText(s); return; }
    if (s.tool === 'table') { setInserting({ kind: 'table', target: s as TableObject }); return; }
    const k = s.kind as string;
    if (k === 'math' || k === 'ce') setInserting({ kind: k, target: s as ImageObject });
    else if (k === 'chem') setInserting({ kind: 'chem', target: s as ImageObject });
  };

  /** 그림 객체 넣기 또는 (위치를 지킨 채) 바꾸기 */
  const placeImage = (target: ImageObject | undefined, src: string, w: number, h: number, extra: Partial<ImageObject>) => {
    const e = engineRef.current;
    if (!e) return;
    if (target) {
      const [[x0, y0]] = target.points;
      e.updateObject(target, { ...extra, src, points: [[x0, y0], [x0 + w, y0 + h]] });
      e.selectObject(target);
    } else {
      e.addImage(src, w, h, extra);
    }
    afterInsert();
  };

  const submitTable = (v: TableValue) => {
    const e = engineRef.current;
    const st = inserting;
    setInserting(null);
    if (!e || !st || st.kind !== 'table') return;
    if (st.target) {
      e.updateObject(st.target, { rows: v.rows, cols: v.cols, header: v.header, cells: v.cells, ...(v.cols !== st.target.cols ? { colW: null } : {}) });
      e.selectObject(st.target);
    } else {
      e.addTable(v);
    }
    afterInsert();
  };

  const submitStructure = (r: StructureResult) => {
    const st = inserting;
    setInserting(null);
    if (!st || st.kind !== 'chem') return;
    // 페이지에 알맞은 크기로 (폭 최대 360)
    const k = Math.min(1, 360 / r.w, 280 / r.h);
    placeImage(st.target, toBase64Svg(r.svg), Math.round(r.w * k), Math.round(r.h * k), { kind: 'chem', molfile: r.molfile, smiles: r.smiles });
  };

  const commitTitle = async (value: string) => {
    setEditingTitle(false);
    const t = value.trim();
    if (!t || t === note.title) return;
    await renameNote(id, t);
    if (docRef.current) docRef.current = { ...docRef.current, title: t };
    const e = engineRef.current;
    if (e) { e.pageHeader = headerFor(t, note.createdAt); e.requestRender(true); }
    await reload();
  };

  const saveLabel = readOnly ? '읽기 전용'
    : save.kind === 'saving' ? '저장 중…'
    : save.kind === 'error' ? '저장 실패'
    : save.at ? `기기에 저장됨 ${fmtDateTime(save.at).slice(11, 16)}` : '기기에 저장됨';
  const pending = c?.pending ?? 0;

  return (
    <div className="screen note-screen">
      <header className="note-bar">
        <button className="icon-btn" onClick={onBack} aria-label="목록으로" data-testid="back"><IcBack /></button>
        <div className="note-title-block">
          {editingTitle && !readOnly ? (
            <input className="title-input" defaultValue={note.title} autoFocus aria-label="노트 제목" data-testid="title-input"
              onBlur={(e) => void commitTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditingTitle(false); }} />
          ) : (
            <button className="title-btn" onClick={() => !readOnly && setEditingTitle(true)} disabled={readOnly}
              aria-label={`노트 제목: ${note.title}${readOnly ? '' : ' (눌러서 고치기)'}`}>
              <span className="title-text" data-testid="note-title">{note.title}</span>
              <span className="note-sub">{note.projectName}{note.noteMno != null ? ` · #${note.noteMno}` : ''}</span>
            </button>
          )}
        </div>

        <div className="pal-anchor status-anchor">
          <button className={`status-pill${save.kind === 'error' ? ' danger' : ''}`} onClick={() => setStatusOpen((v) => !v)} aria-expanded={statusOpen}
            data-testid="status-pill" data-online={online} data-pending={pending}>
            <span className={`dot ${online ? 'on' : 'off'}`} aria-hidden="true" />
            <span data-testid="saved-state">{saveLabel}</span>
            {pending > 0 && <span className="pill-count" data-testid="pill-pending">올릴 버전 {pending}</span>}
            {!online && <span className="pill-off">오프라인</span>}
            {(deadline.urgent || !online) && !lock && <span className={deadline.urgent ? 'warn-text' : 'muted'}>· 기한 {deadline.text}</span>}
          </button>
          {statusOpen && (
            <div className="status-pop" role="dialog" aria-label="동기화 상태" data-testid="status-pop">
              <dl>
                <dt>연결</dt><dd data-testid="net-state">{online ? '온라인' : '오프라인'}</dd>
                <dt>올릴 버전</dt><dd data-testid="pending-count">{pending ? `${pending}개` : '없음 (모두 올림)'}</dd>
                <dt>마지막 동기화</dt><dd>{relativeTime(session.lastSyncAt, now)}</dd>
                <dt>오프라인 작성 기한</dt><dd className={deadline.urgent ? 'warn-text' : ''} data-testid="deadline">{deadline.text}</dd>
              </dl>
              {lastResult && !lastResult.ok && lastResult.error && !lastResult.offline && <p className="small danger-text">{lastResult.error}</p>}
              <button className="btn block" disabled={!online || syncing || lock === 'REVOKED' || lock === 'NEEDS_LOGIN'} onClick={() => void sync()} data-testid="sync-now">
                <IcSync /> {syncing ? '동기화 중…' : '지금 동기화'}
              </button>
            </div>
          )}
        </div>

        <button className="btn ghost" onClick={() => setShowVersions(true)} data-testid="open-versions">
          <IcHistory /> 버전{c?.rejected ? <span className="badge danger" aria-label={`미반영 ${c.rejected}`}>{c.rejected}</span> : null}
        </button>
        <button className="btn primary" disabled={readOnly || busy} onClick={() => setConfirmRelease(true)} data-testid="release">
          <IcCheck /> 작성 완료
        </button>
      </header>

      <LockBanner onRelogin={onRelogin} />
      {block && block.kind !== 'LOCK' && (
        <div className="banner info" data-testid="block-banner" data-kind={block.kind}><IcLock /> {block.message}</div>
      )}

      <div className="canvas-host" ref={hostRef} data-testid="canvas-host" data-tool={pal.tool}>
        <canvas ref={canvasRef} aria-label="필기 페이지" data-testid="board" />
        {!loaded && <div className="canvas-loading muted">노트를 여는 중…</div>}

        {loaded && !readOnly && (
          <ToolPalette engine={engineRef.current!} state={pal} orientation={orientation} onPhoto={(f) => void onPhoto(f)} onInsert={onInsert}
            canUndo={history.undo} canRedo={history.redo} onChange={(next) => setPal((p) => ({ ...p, ...next }))} />
        )}

        {loaded && !readOnly && empty && (
          <div className={`first-hint ${orientation}`} data-testid="first-hint">
            <b>펜으로 바로 쓰세요</b>
            <span>손가락으로는 넘기고 확대합니다. 키보드로 쓰려면 <IcText className="inline-ic" /> 글상자를 고르세요.
              펜이 없으면 <IcHand className="inline-ic" /> 손가락 쓰기를 켜세요.</span>
          </div>
        )}

        {hasSelection && !readOnly && (
          <div className="selection-bar" role="toolbar" aria-label="선택한 항목" data-testid="selection-bar">
            {editable(selObj) && (
              <button className="btn" onClick={editSelected} data-testid="edit-object"><IcEdit /> {objectName(selObj)} 고치기</button>
            )}
            <button className="btn" onClick={() => engineRef.current?.duplicateSelection()}><IcCopy /> 복제</button>
            <button className="btn danger" onClick={() => engineRef.current?.deleteSelection()}><IcTrash /> 삭제</button>
          </div>
        )}
      </div>

      {toast && <div className="toast" role="status" data-testid="toast">{toast}</div>}

      {inserting?.kind === 'table' && (
        <TableDialog initial={inserting.target ? { rows: inserting.target.rows, cols: inserting.target.cols, header: inserting.target.header, cells: inserting.target.cells } : undefined}
          onSubmit={submitTable} onClose={() => setInserting(null)} />
      )}
      {(inserting?.kind === 'math' || inserting?.kind === 'ce') && (
        <FormulaDialog kind={inserting.kind}
          initial={inserting.target ? String((inserting.kind === 'math' ? inserting.target.latex : inserting.target.ce) ?? '') : undefined}
          onClose={() => setInserting(null)}
          onSubmit={(source, img) => {
            const st = inserting;
            setInserting(null);
            placeImage(st.target, img.src, img.w, img.h, st.kind === 'math' ? { kind: 'math', latex: source } : { kind: 'ce', ce: source });
          }} />
      )}
      {inserting?.kind === 'chem' && (
        <Boundary fallback={(err) => (
          <Dialog title="구조식 편집기를 열 수 없습니다" onClose={() => setInserting(null)}>
            <p className="small danger-text">{err.message}</p>
            <div className="row end"><button className="btn" onClick={() => setInserting(null)}>닫기</button></div>
          </Dialog>
        )}>
          <Suspense fallback={<div className="sheet-full"><div className="canvas-loading muted">구조식 편집기를 불러오는 중…</div></div>}>
            <StructureSheet initialMolfile={inserting.target?.molfile} onSubmit={submitStructure} onClose={() => setInserting(null)} />
          </Suspense>
        </Boundary>
      )}

      {confirmRelease && (
        <Dialog title="작성 완료" onClose={() => setConfirmRelease(false)} testId="release-dialog">
          <p>이 노트의 모든 버전을 구노에 올리고 편집권을 구노 웹으로 넘깁니다.</p>
          <ul className="plain-list">
            <li>이후 이 기기에서는 고칠 수 없습니다.</li>
            <li>점검 요청은 구노 웹에서 합니다. 시점인증은 점검할 때 이뤄집니다.</li>
            <li>지금 오프라인이면 연결되는 대로 처리합니다.</li>
          </ul>
          <div className="row end">
            <button className="btn" onClick={() => setConfirmRelease(false)}>취소</button>
            <button className="btn primary" onClick={() => void release()} data-testid="release-confirm">작성 완료</button>
          </div>
        </Dialog>
      )}
      {showVersions && (
        <Versions noteId={id} noteTitle={note.title} canCreate={!readOnly} onCreate={makeVersion} refreshKey={versionsKey + (c?.sent ?? 0) + (c?.pending ?? 0) * 100 + (c?.rejected ?? 0) * 10000}
          onClose={() => setShowVersions(false)} onRestored={(nid) => { setShowVersions(false); onOpen(nid); }} />
      )}
    </div>
  );
}
