import { uuid } from './crypto.ts';
import { db } from './db.ts';
import { contentHash, refsIn, storedToUpload, UPLOAD_PREFIX } from './images.ts';
import type { LocalNote, LocalVersion, Project } from './types.ts';

/** 노트 작업: 만들기, 작업본 저장, 버전 만들기, 작성 완료 요청, 미반영 기록 복원 */

export async function createNote(project: Project, title: string, initialHtml = ''): Promise<LocalNote> {
  const now = new Date().toISOString();
  const note: LocalNote = {
    id: uuid(),
    noteMno: null,
    projectMno: project.projectMno,
    projectName: project.name,
    title: title.trim() || '제목 없음',
    createdAt: now,
    updatedAt: now,
    serverStatus: null,
    editLocation: 'THIS_DEVICE',
    released: false,
    releaseRequested: false,
    reclaimed: false,
    latestServerVersionId: null,
    versionSeq: 0,
    workingSavedAt: initialHtml ? now : null,
    workingDirty: !!initialHtml,
  };
  if (initialHtml) await db.putWorking(note.id, { html: initialHtml, savedAt: now });
  await db.addNote(note);
  return note;
}

/** 작업본 저장 (편집 중 수시로). 서버로는 가지 않는다 */
export async function saveWorking(noteId: string, storedHtml: string): Promise<void> {
  const now = new Date().toISOString();
  await db.putWorking(noteId, { html: storedHtml, savedAt: now });
  await db.updateNote(noteId, (n) => ({ ...n, workingSavedAt: now, workingDirty: true, updatedAt: now }));
}

/**
 * 작업본으로 버전을 만든다 — 서버로 올라가는 단위.
 * autoSave 버전은 바뀐 게 있을 때만 만든다. 만들지 않았으면 null.
 */
export async function createVersion(noteId: string, autoSave: boolean): Promise<LocalVersion | null> {
  const [note, working] = await Promise.all([db.getNote(noteId), db.getWorking(noteId)]);
  if (!note || !working) return null;
  if (!note.workingDirty) return null;

  const imageRefs = refsIn(working.html);
  const images: { ref: string; bytes: Uint8Array }[] = [];
  for (const ref of imageRefs) {
    const img = await db.getImage(ref);
    if (img) images.push({ ref, bytes: img.bytes });
  }
  const v: LocalVersion = {
    id: uuid(),
    noteId,
    seq: note.versionSeq + 1,
    deviceWrittenAt: working.savedAt,
    autoSave,
    html: working.html,
    imageRefs,
    contentHash: await contentHash(storedToUpload(working.html), images),
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
  return v;
}

/** "작성 완료" — 남은 작업본을 버전으로 만들고 반납을 요청한다(실제 반납은 동기화 때) */
export async function requestRelease(noteId: string): Promise<void> {
  await createVersion(noteId, false);
  await db.updateNote(noteId, (n) => ({ ...n, releaseRequested: true, updatedAt: new Date().toISOString() }));
}

/** 미반영 기록을 새 노트로 복원 (이미지는 불변 참조라 그대로 공유) */
export async function restoreAsNewNote(version: LocalVersion, project: Project, title: string): Promise<LocalNote> {
  return createNote(project, title, version.html);
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
