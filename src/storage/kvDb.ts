export type KvKey = string;

type KvRecord = {
  key: KvKey;
  value: unknown;
};

const DB_NAME = "traeky";
const DB_VERSION = 1;
const STORE_NAME = "kv";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

export async function kvGet<T>(key: KvKey): Promise<T | null> {
  const record = await withStore<KvRecord | undefined>("readonly", (store) => store.get(key));
  if (!record || typeof record !== "object") return null;
  return (record as KvRecord).value as T;
}

export async function kvSet(key: KvKey, value: unknown): Promise<void> {
  await withStore<IDBValidKey>("readwrite", (store) => store.put({ key, value } satisfies KvRecord));
}

export async function kvDel(key: KvKey): Promise<void> {
  await withStore<undefined>("readwrite", (store) => store.delete(key));
}

export async function kvGetAllKeys(): Promise<KvKey[]> {
  const keys = await withStore<IDBValidKey[]>("readonly", (store) => store.getAllKeys());
  return keys.map((k) => String(k));
}

export async function kvGetAll(): Promise<KvRecord[]> {
  const items = await withStore<KvRecord[]>("readonly", (store) => store.getAll());
  return Array.isArray(items) ? items : [];
}

export async function kvClear(): Promise<void> {
  await withStore<undefined>("readwrite", (store) => store.clear());
}
