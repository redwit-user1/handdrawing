import { uuid } from './crypto.ts';
import { db } from './db.ts';
import { contentHash, storedToUpload, UPLOAD_PREFIX } from './images.ts';
import type { LocalNote, LocalVersion, Project } from './types.ts';
import { newDoc, type NotebookDoc } from '../notebook/engine.ts';
import { drawingHtml, renderDoc, thumbnailOf } from '../notebook/render.ts';

/** 노트 작업: 만들기, 작업본 저장, 버전 만들기, 작성 완료 요청, 미반영 기록 복원 */

/** 새 노트 기본 제목 — 날짜로 바로 시작하고 나중에 고친다 (필기 전에 키보드를 강요하지 않는다) */
export function defaultTitle(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 연구노트`;
}

export async function createNote(project: Project, title = '', initial?: NotebookDoc): Promise<LocalNote> {
  const now = new Date().toISOString();
  const t = title.trim() || defaultTitle();
  const note: LocalNote = {
    id: uuid(),
    noteMno: null,
    projectMno: project.projectMno,
    projectName: project.name,
    title: t,
    createdAt: now,
    updatedAt: now,
    serverStatus: null,
    editLocation: 'THIS_DEVICE',
    released: false,
    releaseRequested: false,
    reclaimed: false,
    latestServerVersionId: null,
    versionSeq: 0,
    workingSavedAt: now,
    workingDirty: !!initial?.strokes.length,
    thumb: null,
  };
  const doc: NotebookDoc = initial ? { ...initial, title: t } : newDoc(t, new Date(now));
  await db.putWorking(note.id, { doc, savedAt: now });
  await db.addNote(note);
  if (initial?.strokes.length) await refreshThumb(note.id, doc, now);
  return note;
}

export async function getDoc(noteId: string): Promise<NotebookDoc> {
  const [w, note] = await Promise.all([db.getWorking(noteId), db.getNote(noteId)]);
  if (w?.doc) return w.doc;
  return newDoc(note?.title ?? defaultTitle());
}

/** 작업본 저장 (필기할 때마다, 잠깐 멈추면). 서버로는 가지 않는다 */
export async function saveWorking(noteId: string, doc: NotebookDoc): Promise<string> {
  const now = new Date().toISOString();
  await db.putWorking(noteId, { doc, savedAt: now });
  await db.updateNote(noteId, (n) => ({ ...n, workingSavedAt: now, workingDirty: true, updatedAt: now }));
  return now;
}

export async function renameNote(noteId: string, title: string): Promise<void> {
  const t = title.trim();
  if (!t) return;
  const w = await db.getWorking(noteId);
  const now = new Date().toISOString();
  if (w) await db.putWorking(noteId, { doc: { ...w.doc, title: t }, savedAt: now });
  await db.updateNote(noteId, (n) => ({ ...n, title: t, updatedAt: now, workingSavedAt: now, workingDirty: true }));
}

export async function refreshThumb(noteId: string, doc: NotebookDoc, createdAt: string): Promise<void> {
  const thumb = await thumbnailOf(doc, createdAt).catch(() => null);
  await db.updateNote(noteId, (n) => ({ ...n, thumb }));
}

/**
 * 작업본으로 버전을 만든다 — 서버로 올라가는 단위.
 * 페이지를 PNG 로 렌더해 기기 이미지로 저장하고, 웹 구노와 같은 손글씨 블록 HTML 을 만든다.
 * 바뀐 게 없으면 만들지 않는다(null).
 */
export async function createVersion(noteId: string, autoSave: boolean): Promise<LocalVersion | null> {
  const [note, working] = await Promise.all([db.getNote(noteId), db.getWorking(noteId)]);
  if (!note || !working) return null;
  if (!note.workingDirty) return null;

  const doc = { ...working.doc, title: note.title };
  const r = await renderDoc(doc, note.createdAt);
  const refs: string[] = [];
  for (const png of r.pngs) refs.push(await db.putImage(png, 'image/png', noteId));
  const html = drawingHtml(r.canonical, r.sha256, refs);
  const images = [];
  for (let i = 0; i < refs.length; i++) images.push({ ref: refs[i], bytes: r.pngs[i] });

  const v: LocalVersion = {
    id: uuid(),
    noteId,
    seq: note.versionSeq + 1,
    deviceWrittenAt: working.savedAt,
    autoSave,
    html,
    title: note.title,
    imageRefs: refs,
    contentHash: await contentHash(storedToUpload(html), images),
    state: 'PENDING',
    attempts: 0,
  };
  await db.appendVersion(v);
  // 버전을 만드는 사이 작업본이 또 저장됐으면 dirty 를 유지한다
  await db.updateNote(noteId, (n) => ({
    ...n,
    versionSeq: v.seq,
    workingDirty: n.workingSavedAt === working.savedAt ? false : n.workingDirty,
    syncIssue: null,
  }));
  await refreshThumb(noteId, doc, note.createdAt);
  return v;
}

/** "작성 완료" — 남은 작업본을 버전으로 만들고 반납을 요청한다(실제 반납은 동기화 때) */
export async function requestRelease(noteId: string): Promise<void> {
  await createVersion(noteId, false);
  await db.updateNote(noteId, (n) => ({ ...n, releaseRequested: true, updatedAt: new Date().toISOString() }));
}

/** 미반영 기록(버전)을 새 노트로 복원 */
export async function restoreAsNewNote(doc: NotebookDoc, project: Project, title: string): Promise<LocalNote> {
  return createNote(project, title, doc);
}

/** 전송용 본문·이미지 (images.ts 규칙) */
export async function uploadPayload(v: LocalVersion): Promise<{ html: string; images: { src: string; bytes: Uint8Array; mime: string }[]; missing: string[] }> {
  const images: { src: string; bytes: Uint8Array; mime: string }[] = [];
  const missing: string[] = [];
  for (const ref of v.imageRefs) {
    const img = await db.getImage(ref);
    if (img) images.push({ src: UPLOAD_PREFIX + ref, bytes: img.bytes, mime: img.mime });
    else missing.push(ref);
  }
  return { html: storedToUpload(v.html), images, missing };
}
