import { storage } from './storage.ts';
import { uuid } from './crypto.ts';
import type { ImageMeta, LocalNote, LocalVersion, Meta, Session } from './types.ts';

/**
 * 기기 저장소 구성 (모두 암호화):
 *
 *   session.json            세션(기기 토큰, 오프라인 기한)
 *   meta.json               기준 정보(프로젝트 목록 등)
 *   notes.json              노트 목록
 *   working/{noteId}.json   작업본 — 편집 중 수시로 저장, 서버로는 가지 않는다
 *   versions/{noteId}.json  버전 — 서버로 올라가는 단위. 쌓기만 하고 지우지 않는다
 *   images/{ref}.bin        본문 이미지(손글씨 페이지 포함)
 *   images.json             이미지 목록
 */
const F = {
  session: 'session.json',
  meta: 'meta.json',
  notes: 'notes.json',
  images: 'images.json',
  working: (noteId: string) => `working/${noteId}.json`,
  versions: (noteId: string) => `versions/${noteId}.json`,
  image: (ref: string) => `images/${ref}.bin`,
};

export interface WorkingCopy { html: string; savedAt: string }

export const db = {
  getSession: () => storage.getJSON<Session>(F.session),
  putSession: (s: Session) => storage.putJSON(F.session, s),
  updateSession: (fn: (s: Session) => Session) =>
    storage.update<Session | null>(F.session, null, (cur) => (cur ? fn(cur) : cur)),

  getMeta: () => storage.getJSON<Meta>(F.meta),
  putMeta: (m: Meta) => storage.putJSON(F.meta, m),

  async listNotes(): Promise<LocalNote[]> {
    return (await storage.getJSON<LocalNote[]>(F.notes)) ?? [];
  },
  async getNote(id: string): Promise<LocalNote | null> {
    return (await this.listNotes()).find((n) => n.id === id) ?? null;
  },
  async addNote(note: LocalNote): Promise<void> {
    await storage.update<LocalNote[]>(F.notes, [], (list) => [note, ...list.filter((n) => n.id !== note.id)]);
  },
  /** 노트 한 건을 고친다. 없으면 null */
  async updateNote(id: string, fn: (n: LocalNote) => LocalNote): Promise<LocalNote | null> {
    let out: LocalNote | null = null;
    await storage.update<LocalNote[]>(F.notes, [], (list) => list.map((n) => (n.id === id ? (out = fn(n)) : n)));
    return out;
  },

  getWorking: (noteId: string) => storage.getJSON<WorkingCopy>(F.working(noteId)),
  putWorking: (noteId: string, w: WorkingCopy) => storage.putJSON(F.working(noteId), w),

  async listVersions(noteId: string): Promise<LocalVersion[]> {
    return (await storage.getJSON<LocalVersion[]>(F.versions(noteId))) ?? [];
  },
  async appendVersion(v: LocalVersion): Promise<void> {
    await storage.update<LocalVersion[]>(F.versions(v.noteId), [], (list) => [...list, v]);
  },
  async updateVersion(noteId: string, versionId: string, fn: (v: LocalVersion) => LocalVersion): Promise<void> {
    await storage.update<LocalVersion[]>(F.versions(noteId), [], (list) => list.map((v) => (v.id === versionId ? fn(v) : v)));
  },

  /** 이미지를 암호화해 저장하고 참조(ref)를 돌려준다. 같은 ref는 다시 쓰지 않는다(불변) */
  async putImage(bytes: Uint8Array, mime: string, noteId: string): Promise<string> {
    const ref = uuid();
    await storage.putBytes(F.image(ref), bytes);
    await storage.update<Record<string, ImageMeta>>(F.images, {}, (idx) => ({ ...idx, [ref]: { mime, size: bytes.length, noteId } }));
    return ref;
  },
  async getImage(ref: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
    const [bytes, idx] = await Promise.all([
      storage.getBytes(F.image(ref)),
      storage.getJSON<Record<string, ImageMeta>>(F.images),
    ]);
    if (!bytes) return null;
    return { bytes, mime: idx?.[ref]?.mime ?? 'application/octet-stream' };
  },

  wipe: () => storage.wipe(),
};
