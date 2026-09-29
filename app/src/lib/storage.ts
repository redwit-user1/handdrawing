import { Directory, Filesystem } from '@capacitor/filesystem';
import { decrypt, encrypt, fromBase64, toBase64 } from './crypto.ts';

/**
 * 암호화 파일 저장소 — 앱 데이터 영역(Directory.Data) 아래 goono-note/.
 * 네이티브에서는 앱 샌드박스 파일(브라우저 저장소 삭제 정책 대상 아님), 브라우저에서는 플러그인이
 * IndexedDB로 대신한다. 모든 내용은 AES-GCM으로 암호화해 base64로 쓴다.
 *
 * 같은 파일에 대한 읽기·쓰기는 순서대로 처리한다(자동 저장과 동기화가 겹쳐도 덮어쓰기 경합 없음).
 */
const ROOT = 'goono-note';
const locks = new Map<string, Promise<unknown>>();

function serialize<T>(file: string, task: () => Promise<T>): Promise<T> {
  const prev = locks.get(file) ?? Promise.resolve();
  const next = prev.then(task, task);
  locks.set(file, next.catch(() => undefined));
  return next;
}

const p = (file: string) => `${ROOT}/${file}`;

async function readRaw(file: string): Promise<Uint8Array | null> {
  try {
    const r = await Filesystem.readFile({ path: p(file), directory: Directory.Data });
    const data = r.data as string | Blob;
    const b64 = typeof data === 'string' ? data : toBase64(new Uint8Array(await data.arrayBuffer()));
    return decrypt(fromBase64(b64));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/not exist|does not exist|File does not exist|ENOENT|not found/i.test(msg)) return null;
    throw e;
  }
}

async function writeRaw(file: string, plain: Uint8Array): Promise<void> {
  const data = toBase64(await encrypt(plain));
  await Filesystem.writeFile({ path: p(file), directory: Directory.Data, data, recursive: true });
}

export const storage = {
  async getJSON<T>(file: string): Promise<T | null> {
    return serialize(file, async () => {
      const raw = await readRaw(file);
      return raw ? (JSON.parse(new TextDecoder().decode(raw)) as T) : null;
    });
  },

  async putJSON(file: string, value: unknown): Promise<void> {
    return serialize(file, () => writeRaw(file, new TextEncoder().encode(JSON.stringify(value))));
  },

  /** 읽고-고치고-쓰기를 한 번에 (같은 파일의 다른 갱신과 섞이지 않음) */
  async update<T>(file: string, fallback: T, fn: (cur: T) => T | Promise<T>): Promise<T> {
    return serialize(file, async () => {
      const raw = await readRaw(file);
      const cur = raw ? (JSON.parse(new TextDecoder().decode(raw)) as T) : fallback;
      const next = await fn(cur);
      await writeRaw(file, new TextEncoder().encode(JSON.stringify(next)));
      return next;
    });
  },

  async getBytes(file: string): Promise<Uint8Array | null> {
    return serialize(file, () => readRaw(file));
  },

  async putBytes(file: string, bytes: Uint8Array): Promise<void> {
    return serialize(file, () => writeRaw(file, bytes));
  },

  async remove(file: string): Promise<void> {
    return serialize(file, async () => {
      try { await Filesystem.deleteFile({ path: p(file), directory: Directory.Data }); } catch { /* 없음 */ }
    });
  },

  /** 전체 삭제 (로그아웃 후 기기 초기화) */
  async wipe(): Promise<void> {
    try { await Filesystem.rmdir({ path: ROOT, directory: Directory.Data, recursive: true }); } catch { /* 없음 */ }
  },
};
