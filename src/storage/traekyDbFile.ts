import { kvGet, kvSet, kvGetAll } from "./kvDb";

const SYNC_FILE_HANDLE_KEY = "traeky:sync:fileHandle";
const DB_LAST_WRITE_KEY = "traeky:db:lastWrite";

export type TraekyDbFileFormatV1 = {
  magic: "traeky.db";
  version: 1;
  exportedAt: string;
  lastWrite: string | null;
  kv: Record<string, unknown>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function isKeyExportable(key: string): boolean {
  if (!key.startsWith("traeky:")) {
    return false;
  }
  // Do not export the browser-granted file handle.
  if (key === SYNC_FILE_HANDLE_KEY) {
    return false;
  }
  return true;
}

export function isFileSystemAccessSupported(): boolean {
  // Chromium-based browsers
  return typeof (window as any)?.showSaveFilePicker === "function";
}

export async function exportTraekyDbToJson(): Promise<string> {
  const all = await kvGetAll();
  const kv: Record<string, unknown> = {};
  for (const record of all) {
    if (!record || typeof record.key !== "string") continue;
    if (!isKeyExportable(record.key)) continue;
    kv[record.key] = record.value;
  }

  const lastWrite = await kvGet<string>(DB_LAST_WRITE_KEY);
  const payload: TraekyDbFileFormatV1 = {
    magic: "traeky.db",
    version: 1,
    exportedAt: nowIso(),
    lastWrite: lastWrite ?? null,
    kv,
  };

  return JSON.stringify(payload);
}

export async function importTraekyDbFromJson(json: string): Promise<void> {
  const parsed = JSON.parse(json) as Partial<TraekyDbFileFormatV1>;
  if (!parsed || parsed.magic !== "traeky.db" || parsed.version !== 1 || !parsed.kv) {
    throw new Error("Unsupported traeky.db file format");
  }

  const kv = parsed.kv as Record<string, unknown>;
  for (const [key, value] of Object.entries(kv)) {
    if (!isKeyExportable(key)) {
      continue;
    }
    await kvSet(key, value);
  }

  // Keep the newer lastWrite value.
  const incomingLastWrite = typeof parsed.lastWrite === "string" ? parsed.lastWrite : null;
  const existingLastWrite = await kvGet<string>(DB_LAST_WRITE_KEY);
  if (!existingLastWrite || (incomingLastWrite && incomingLastWrite > existingLastWrite)) {
    await kvSet(DB_LAST_WRITE_KEY, incomingLastWrite ?? nowIso());
  }
}

export async function pickOrCreateSyncFile(): Promise<void> {
  if (!isFileSystemAccessSupported()) {
    throw new Error("File System Access API is not supported in this browser");
  }

  const handle = await (window as any).showSaveFilePicker({
    suggestedName: "traeky.db",
    types: [
      {
        description: "Traeky Database",
        accept: { "application/json": [".db", ".json"] },
      },
    ],
  });
  await kvSet(SYNC_FILE_HANDLE_KEY, handle);
  await writeSyncFileNow();
}

export async function getSyncFileName(): Promise<string | null> {
  const handle = await kvGet<any>(SYNC_FILE_HANDLE_KEY);
  if (!handle) return null;
  return typeof handle.name === "string" ? handle.name : "traeky.db";
}

export async function writeSyncFileNow(): Promise<void> {
  const handle = await kvGet<any>(SYNC_FILE_HANDLE_KEY);
  if (!handle) {
    return;
  }
  const json = await exportTraekyDbToJson();
  const writable = await handle.createWritable();
  await writable.write(json);
  await writable.close();
  await kvSet(DB_LAST_WRITE_KEY, nowIso());
}

export async function readSyncFileIfNewer(): Promise<boolean> {
  const handle = await kvGet<any>(SYNC_FILE_HANDLE_KEY);
  if (!handle) return false;

  try {
    const file: File = await handle.getFile();
    const json = await file.text();
    const parsed = JSON.parse(json) as Partial<TraekyDbFileFormatV1>;
    if (!parsed || parsed.magic !== "traeky.db" || parsed.version !== 1) {
      return false;
    }

    const incomingLastWrite = typeof parsed.lastWrite === "string" ? parsed.lastWrite : null;
    const existingLastWrite = await kvGet<string>(DB_LAST_WRITE_KEY);
    if (!existingLastWrite || (incomingLastWrite && incomingLastWrite > existingLastWrite)) {
      await importTraekyDbFromJson(json);
      return true;
    }
  } catch {
    // If reading fails (permissions revoked, file deleted, etc.) we treat it as non-fatal.
    return false;
  }

  return false;
}

let syncTimer: number | null = null;
export function scheduleAutoSync(): void {
  if (syncTimer != null) {
    window.clearTimeout(syncTimer);
  }
  syncTimer = window.setTimeout(() => {
    syncTimer = null;
    void writeSyncFileNow();
  }, 900);
}

