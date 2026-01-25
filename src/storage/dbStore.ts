import { idbGet, idbSet } from "./idb";
import { createEmptyDb, parseDb, serializeDb, type TraekyDb } from "./traekyDb";
import type { Language } from "../i18n";

export type DbSyncStatus = {
  isReady: boolean;
  isDirty: boolean;
  lastSyncedAt: string | null;
  fileLabel: string | null;
  /**
   * "handle" if the File System Access API is available and a file handle is bound.
   * "download" otherwise.
   */
  saveMechanism: "handle" | "download";
  conflicts: number;
};

type DbListener = () => void;

type FilePickerType = { description: string; accept: Record<string, string[]> };
type OpenFilePickerOptions = { types: FilePickerType[]; multiple: boolean };
type SaveFilePickerOptions = { suggestedName: string; types: FilePickerType[] };
type WindowWithFsAccess = Window & {
  showOpenFilePicker?: (options: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (options: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
};

let db: TraekyDb | null = null;
let isDirty = false;
let lastSyncedAt: string | null = null;
let fileLabel: string | null = null;
let conflicts = 0;

// File System Access API handle (Chromium). Not supported in Firefox.
let fileHandle: FileSystemFileHandle | null = null;

const IDB_HANDLE_KEY = "db:file-handle";

const listeners = new Set<DbListener>();

function notify(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      // ignore
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}


async function readFileAsText(file: File): Promise<string> {
  return await file.text();
}

function supportsFileSystemAccess(): boolean {
  const w = window as WindowWithFsAccess;
  return typeof w.showOpenFilePicker === "function";
}

function hasBoundHandle(): boolean {
  return !!fileHandle;
}

async function tryReadBoundHandle(): Promise<void> {
  if (!supportsFileSystemAccess()) {
    return;
  }
  try {
    const handle = await idbGet<FileSystemFileHandle | null>(IDB_HANDLE_KEY);
    if (!handle) {
      return;
    }
    // Firefox will throw on structured clone of handles, so this may be null.
    fileHandle = handle;
    const file = await handle.getFile();
    const text = await readFileAsText(file);
    const parsed = parseDb(text);
    db = parsed;
    isDirty = false;
    lastSyncedAt = nowIso();
    fileLabel = file.name;
    conflicts = 0;
    notify();
  } catch {
    // Ignore; user must pick manually.
    fileHandle = null;
  }
}

export function subscribeDb(listener: DbListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDbSyncStatus(): DbSyncStatus {
  return {
    isReady: !!db,
    isDirty,
    lastSyncedAt,
    fileLabel,
    saveMechanism: supportsFileSystemAccess() && hasBoundHandle() ? "handle" : "download",
    conflicts,
  };
}

export function isDbReady(): boolean {
  return !!db;
}

export function getDb(): TraekyDb {
  if (!db) {
    throw new Error("Database not loaded");
  }
  return db;
}

export function markDbDirty(): void {
  if (!db) return;
  isDirty = true;
  db.updatedAt = nowIso();
  db.meta.revision = Math.max(1, (db.meta.revision ?? 0) + 1);
  notify();
}

export function setUiLanguage(lang: Language): void {
  if (!db) return;
  db.ui.lang = lang;
  markDbDirty();
}

export function getUiLanguage(fallback: Language): Language {
  if (!db) return fallback;
  return db.ui.lang ?? fallback;
}

export async function initDbAuto(defaultLang: Language): Promise<void> {
  if (db) {
    return;
  }
  // Start with an in-memory DB so the UI can render deterministically.
  db = createEmptyDb(nowIso(), defaultLang);
  isDirty = true;
  fileLabel = null;
  lastSyncedAt = null;
  conflicts = 0;
  notify();
  await tryReadBoundHandle();
}

async function pickFileWithFallback(accept: string): Promise<File | null> {
  if (supportsFileSystemAccess()) {
    try {
      const w = window as WindowWithFsAccess;
      const [handle] = await w.showOpenFilePicker!({
        types: [{ description: "Traeky DB", accept: { [accept]: [".json", ".db", ".traeky"] } }],
        multiple: false,
      });
      if (!handle) return null;
      fileHandle = handle;
      try {
        await idbSet(IDB_HANDLE_KEY, handle);
      } catch {
        // Ignore (Firefox / permission issues).
      }
      const file = await handle.getFile();
      fileLabel = file.name;
      return file;
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.db,.traeky,application/json";
    input.onchange = () => {
      const file = input.files && input.files.length ? input.files[0] : null;
      resolve(file);
    };
    input.click();
  });
}

export async function openDbInteractive(): Promise<void> {
  const file = await pickFileWithFallback("application/json");
  if (!file) {
    return;
  }
  const text = await readFileAsText(file);
  db = parseDb(text);
  isDirty = false;
  lastSyncedAt = nowIso();
  fileLabel = file.name;
  conflicts = 0;
  notify();
}

async function saveViaHandle(handle: FileSystemFileHandle, content: string): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

function saveViaDownload(filename: string, content: string): void {
  // Avoid ArrayBufferLike/SharedArrayBuffer typing issues by letting Blob handle UTF-8 encoding.
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function syncDbNow(): Promise<void> {
  if (!db) {
    throw new Error("Database not loaded");
  }
  const content = serializeDb(db);

  if (supportsFileSystemAccess() && fileHandle) {
    await saveViaHandle(fileHandle, content);
  } else {
    const w = window as WindowWithFsAccess;
    if (typeof w.showSaveFilePicker === "function") {
    // In some Chromium builds, showSaveFilePicker is available even without persisted handles.
      const handle: FileSystemFileHandle = await w.showSaveFilePicker({
      suggestedName: fileLabel ?? "traeky-db.json",
      types: [{ description: "Traeky DB", accept: { "application/json": [".json"] } }],
    });
    fileHandle = handle;
    try {
      await idbSet(IDB_HANDLE_KEY, handle);
    } catch {
      // ignore
    }
      await saveViaHandle(handle, content);
    } else {
      saveViaDownload(fileLabel ?? "traeky-db.json", content);
    }
  }

  isDirty = false;
  lastSyncedAt = nowIso();
  notify();
}

export async function createNewDbInteractive(defaultLang: Language): Promise<void> {
  db = createEmptyDb(nowIso(), defaultLang);
  isDirty = true;
  lastSyncedAt = null;
  conflicts = 0;
  fileLabel = fileLabel ?? "traeky-db.json";
  notify();
  // Immediately prompt the user to choose the save location.
  await syncDbNow();
}

type AnyProfileMeta = { id: string; updatedAt: string };

function compareIso(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) {
    return a.localeCompare(b);
  }
  return ta === tb ? 0 : ta < tb ? -1 : 1;
}

/**
 * Merge an imported DB into the currently loaded DB.
 *
 * - Profiles are merged by id.
 * - The newer updatedAt wins.
 * - If updatedAt is equal but payload differs, we keep the local version and
 *   record a conflict counter so the UI can warn.
 */
export function mergeImportedDb(imported: TraekyDb): void {
  if (!db) {
    db = imported;
    isDirty = false;
    conflicts = 0;
    lastSyncedAt = nowIso();
    notify();
    return;
  }

  const local = db;
  const localProfiles = new Map<string, AnyProfileMeta>();
  for (const p of local.index.profiles) {
    localProfiles.set(p.id, { id: p.id, updatedAt: p.updatedAt });
  }
  const importedProfiles = new Map<string, AnyProfileMeta>();
  for (const p of imported.index.profiles) {
    importedProfiles.set(p.id, { id: p.id, updatedAt: p.updatedAt });
  }

  const allIds = new Set<string>([...localProfiles.keys(), ...importedProfiles.keys()]);
  const mergedProfiles: typeof local.index.profiles = [];
  const mergedData: typeof local.profileData = { ...local.profileData };
  let conflictCount = 0;

  for (const id of allIds) {
    const lp = local.index.profiles.find((p) => p.id === id);
    const ip = imported.index.profiles.find((p) => p.id === id);
    const localUpdatedAt = lp?.updatedAt ?? "";
    const importedUpdatedAt = ip?.updatedAt ?? "";

    if (!lp && ip) {
      mergedProfiles.push(ip);
      mergedData[id] = imported.profileData[id];
      continue;
    }
    if (lp && !ip) {
      mergedProfiles.push(lp);
      continue;
    }
    if (!lp || !ip) {
      continue;
    }

    const cmp = compareIso(localUpdatedAt, importedUpdatedAt);
    if (cmp < 0) {
      mergedProfiles.push(ip);
      mergedData[id] = imported.profileData[id];
      continue;
    }

    if (cmp === 0) {
      const localPayload = local.profileData[id];
      const importedPayload = imported.profileData[id];
      const localCipher = localPayload?.ciphertext ?? "";
      const importedCipher = importedPayload?.ciphertext ?? "";
      if (localCipher && importedCipher && localCipher !== importedCipher) {
        conflictCount += 1;
      }
    }

    mergedProfiles.push(lp);
  }

  local.index.profiles = mergedProfiles;
  local.profileData = mergedData;

  // Keep local ui settings and currentProfileId unless it becomes invalid.
  if (local.index.currentProfileId && !mergedData[local.index.currentProfileId]) {
    local.index.currentProfileId = mergedProfiles.length ? mergedProfiles[0].id : null;
  }

  conflicts = conflictCount;
  markDbDirty();
}

export async function importDbInteractive(): Promise<void> {
  const file = await pickFileWithFallback("application/json");
  if (!file) return;
  const text = await readFileAsText(file);
  const imported = parseDb(text);
  mergeImportedDb(imported);
}
