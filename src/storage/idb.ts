type IdbValue = unknown;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB not available"));
      return;
    }
    const req = indexedDB.open("traeky", 1);
    req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) {
        db.createObjectStore("kv");
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

export async function idbGet<T = IdbValue>(key: string): Promise<T | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readonly");
    const store = tx.objectStore("kv");
    const req = store.get(key);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB get failed"));
    req.onsuccess = () => {
      const val = req.result as T | undefined;
      resolve(val ?? null);
    };
  });
}

export async function idbSet(key: string, value: IdbValue): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    const store = tx.objectStore("kv");
    const req = store.put(value, key);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB put failed"));
    req.onsuccess = () => resolve();
  });
}

export async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    const store = tx.objectStore("kv");
    const req = store.delete(key);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB delete failed"));
    req.onsuccess = () => resolve();
  });
}
