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

type SaveFilePickerOptionsLike = {
  suggestedName?: string;
  types?: Array<{
    description?: string;
    accept?: Record<string, string[]>;
  }>;
};

type WritableFileStreamLike = {
  write: (data: string) => Promise<void>;
  close: () => Promise<void>;
};

type FileHandleLike = {
  name?: string;
  getFile: () => Promise<File>;
  createWritable: () => Promise<WritableFileStreamLike>;
};

function getFsApi(): { showSaveFilePicker?: (options: SaveFilePickerOptionsLike) => Promise<FileHandleLike> } {
  return window as unknown as {
    showSaveFilePicker?: (options: SaveFilePickerOptionsLike) => Promise<FileHandleLike>;
  };
}

function isFileHandleLike(value: unknown): value is FileHandleLike {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec["getFile"] === "function" && typeof rec["createWritable"] === "function";
}

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
  return typeof getFsApi().showSaveFilePicker === "function";
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

  const fsApi = getFsApi();
  if (!fsApi.showSaveFilePicker) {
    throw new Error("File System Access API is not supported in this browser");
  }

  const handle = await fsApi.showSaveFilePicker({
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
  const handleRaw = await kvGet<unknown>(SYNC_FILE_HANDLE_KEY);
  if (!isFileHandleLike(handleRaw)) return null;
  return typeof handleRaw.name === "string" ? handleRaw.name : "traeky.db";
}

export async function writeSyncFileNow(): Promise<void> {
  const handleRaw = await kvGet<unknown>(SYNC_FILE_HANDLE_KEY);
  if (!isFileHandleLike(handleRaw)) return;
  const json = await exportTraekyDbToJson();
  const writable = await handleRaw.createWritable();
  await writable.write(json);
  await writable.close();
  await kvSet(DB_LAST_WRITE_KEY, nowIso());
}

export async function readSyncFileIfNewer(): Promise<boolean> {
  const handleRaw = await kvGet<unknown>(SYNC_FILE_HANDLE_KEY);
  if (!isFileHandleLike(handleRaw)) return false;

  try {
    const file: File = await handleRaw.getFile();
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

