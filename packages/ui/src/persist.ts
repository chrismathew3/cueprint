// Local-first library: analysis in IndexedDB (typed arrays store natively),
// the video itself in OPFS so a set reopens instantly with no re-import.
import type { Analysis, SetMeta } from "@cueprint/core";

const DB = "cueprint";
const VERSION = 1;

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("meta", { keyPath: "id" });
      d.createObjectStore("analysis");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    const r = fn(d.transaction(store, mode).objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

export const listSets = () => tx<SetMeta[]>("meta", "readonly", (s) => s.getAll() as IDBRequest<SetMeta[]>)
  .then((xs) => xs.sort((a, b) => b.createdAt - a.createdAt));
export const saveMeta = (m: SetMeta) => tx("meta", "readwrite", (s) => s.put(m));
export const loadAnalysis = (id: string) => tx<Analysis | undefined>("analysis", "readonly", (s) => s.get(id));
export const saveAnalysis = (id: string, a: Analysis) => tx("analysis", "readwrite", (s) => s.put(a, id));

export async function deleteSet(id: string) {
  await tx("meta", "readwrite", (s) => s.delete(id));
  await tx("analysis", "readwrite", (s) => s.delete(id));
  try { (await videosDir()).removeEntry(id); } catch { /* already gone */ }
}

async function videosDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("videos", { create: true });
}

/** Stream the file into OPFS. Best effort: if storage is full, the set still works this session. */
export async function storeVideo(id: string, file: Blob): Promise<boolean> {
  try {
    await navigator.storage.persist?.();
    const handle = await (await videosDir()).getFileHandle(id, { create: true });
    const w = await handle.createWritable();
    await file.stream().pipeTo(w);
    return true;
  } catch {
    return false;
  }
}

export async function loadVideo(id: string): Promise<File | null> {
  try {
    const handle = await (await videosDir()).getFileHandle(id);
    return await handle.getFile();
  } catch {
    return null;
  }
}

export async function setIdFor(file: File): Promise<string> {
  // name + size + first 64 KB hash: stable across re-imports of the same file, cheap for multi-GB sets
  const head = await file.slice(0, 65536).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", head);
  const hex = [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex}-${file.size.toString(36)}`;
}
