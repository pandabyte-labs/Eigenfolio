import type { Language } from "../i18n";

import { idbGet, idbSet } from "./idb";
import { createEmptyDb, type TraekyDb } from "./traekyDb";
import { parseDbFromSqlite, serializeDbToSqlite } from "./sqliteCodec";
import type { ProfileId } from "../auth/profileTypes";
import type { EncryptedPayload } from "../crypto/cryptoService";

//
// Persistence model
//
// - Chromium browsers: File System Access API (persisted file handle)
// - Firefox: snapshot persisted in IndexedDB + manual export/import (download/open)
//

type WindowWithFsAccess = Window & {
  showOpenFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle>;
};

export type DbSyncStatus = {
  isReady: boolean;
  isDirty: boolean;
  lastSyncedAt: string | null;
  fileLabel: string | null;
  conflicts: number;
  dbRevision: number;
  isInitializing: boolean;
};

type DbListener = () => void;

const IDB_HANDLE_KEY = "traeky:db:file-handle";
const IDB_SNAPSHOT_KEY = "traeky:db:sqlite-snapshot";
const IDB_FILE_LABEL_KEY = "traeky:db:file-label";

// Legacy (localStorage) keys from older Traeky builds.
const LS_PROFILES_INDEX_KEY = "traeky:profiles:index";
const LS_PROFILE_DATA_PREFIX = "traeky:profile:";
const LS_PROFILE_DATA_SUFFIX = ":data";

let db: TraekyDb | null = null;
let isDirty = false;
let lastSyncedAt: string | null = null;
let fileLabel: string | null = null;
let conflicts = 0;
let isInitializing = false;

let fileHandle: FileSystemFileHandle | null = null;

const listeners = new Set<DbListener>();

function nowIso(): string {
  return new Date().toISOString();
}

function notify(): void {
  listeners.forEach((fn) => fn());
}

export function subscribeDb(listener: DbListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDbSyncStatus(): DbSyncStatus {
  return {
    isReady: !!db && !isInitializing,
    isDirty,
    lastSyncedAt,
    fileLabel,
    conflicts,
    dbRevision: db?.meta?.revision ?? 0,
    isInitializing,
  };
}

export function getDb(): TraekyDb {
  if (!db) {
    throw new Error("Database not initialized");
  }
  return db;
}

export function markDbDirty(): void {
  if (!db) {
    throw new Error("Database not initialized");
  }
  isDirty = true;
  db.updatedAt = nowIso();
  db.meta.revision = Math.max(1, (db.meta.revision ?? 0) + 1);
  notify();
}

function supportsFileSystemAccess(): boolean {
  return typeof window !== "undefined" && "showOpenFilePicker" in window;
}

async function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("File read failed"));
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) {
        resolve(result);
        return;
      }
      reject(new Error("Unexpected file reader result"));
    };
    reader.readAsArrayBuffer(file);
  });
}

async function pickFileWithFallback(): Promise<File | null> {
  const w = window as WindowWithFsAccess;
  if (typeof w.showOpenFilePicker === "function") {
    const handles = await w.showOpenFilePicker({
      multiple: false,
      types: [
        {
          description: "Traeky DB",
          accept: {
            "application/x-sqlite3": [".sqlite", ".db"],
            "application/octet-stream": [".sqlite", ".db", ".traeky"],
          },
        },
      ],
    });
    const handle = handles[0];
    if (!handle) return null;
    fileHandle = handle;
    try {
      await idbSet(IDB_HANDLE_KEY, handle);
    } catch {
      // ignore
    }
    const file = await handle.getFile();
    return file;
  }

  // Firefox fallback: plain input picker.
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".sqlite,.db,.traeky";
    input.onchange = () => {
      resolve(input.files && input.files[0] ? input.files[0] : null);
    };
    input.click();
  });
}

async function loadDbFromFile(file: File, fallbackLang: Language): Promise<TraekyDb> {
  const buf = await readFileAsArrayBuffer(file);
  const bytes = new Uint8Array(buf);
  return parseDbFromSqlite(bytes, fallbackLang);
}

function saveViaDownload(filename: string, content: Uint8Array): void {
  const bytes = Uint8Array.from(content);
  const blob = new Blob([bytes], { type: "application/x-sqlite3" });
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

async function saveViaHandle(handle: FileSystemFileHandle, content: Uint8Array): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(Uint8Array.from(content));
  await writable.close();
}

async function tryRestoreHandle(): Promise<void> {
  if (!supportsFileSystemAccess()) {
    return;
  }
  try {
    const stored = await idbGet<FileSystemFileHandle>(IDB_HANDLE_KEY);
    if (!stored) return;
    fileHandle = stored;
  } catch {
    // ignore
  }
}

async function tryLoadFromHandle(fallbackLang: Language): Promise<boolean> {
  if (!supportsFileSystemAccess() || !fileHandle) {
    return false;
  }
  try {
    const file = await fileHandle.getFile();
    const loaded = await loadDbFromFile(file, fallbackLang);
    db = loaded;
    isDirty = false;
    lastSyncedAt = nowIso();
    fileLabel = file.name;
    conflicts = 0;
    try {
      await idbSet(IDB_FILE_LABEL_KEY, fileLabel);
    } catch {
      // ignore
    }
    await idbSet(IDB_SNAPSHOT_KEY, await serializeDbToSqlite(loaded));
    return true;
  } catch {
    return false;
  }
}

async function tryLoadFromSnapshot(fallbackLang: Language): Promise<boolean> {
  try {
    const stored = await idbGet<Uint8Array>(IDB_SNAPSHOT_KEY);
    if (!stored) return false;
    const loaded = await parseDbFromSqlite(stored, fallbackLang);
    db = loaded;
    isDirty = false;
    conflicts = 0;
    try {
      const label = await idbGet<string>(IDB_FILE_LABEL_KEY);
      if (typeof label === "string" && label) {
        fileLabel = label;
      }
    } catch {
      // ignore
    }
    return true;
  } catch {
    return false;
  }
}

function getLocalStorage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // ignore
  }
  return null;
}

function readLocalStorageJson(key: string): unknown {
  const storage = getLocalStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function buildLegacyProfileDataKey(profileId: string): string {
  return `${LS_PROFILE_DATA_PREFIX}${profileId}${LS_PROFILE_DATA_SUFFIX}`;
}

function migrateLegacyLocalStorageIntoDb(target: TraekyDb): boolean {
  if (target.index.profiles.length > 0) {
    return false;
  }
  const idx = readLocalStorageJson(LS_PROFILES_INDEX_KEY);
  if (!idx || typeof idx !== "object") {
    return false;
  }
  const idxObj = idx as Record<string, unknown>;
  const profilesCandidate = idxObj.profiles;
  if (!Array.isArray(profilesCandidate) || profilesCandidate.length === 0) {
    return false;
  }

  const importedProfiles = profilesCandidate
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => {
      const id = typeof p.id === "string" ? p.id : "";
      const name = typeof p.name === "string" ? p.name : "";
      if (!id || !name) return null;
      const createdAt = typeof p.createdAt === "string" ? p.createdAt : nowIso();
      const updatedAt = typeof p.updatedAt === "string" ? p.updatedAt : createdAt;
      return { id, name, createdAt, updatedAt };
    })
    .filter((p): p is { id: ProfileId; name: string; createdAt: string; updatedAt: string } => !!p);

  if (importedProfiles.length === 0) {
    return false;
  }

  const importedProfileData: Record<ProfileId, EncryptedPayload | undefined> = {};
  for (const p of importedProfiles) {
    const payloadRaw = readLocalStorageJson(buildLegacyProfileDataKey(p.id));
    if (!payloadRaw || typeof payloadRaw !== "object") {
      continue;
    }
    const obj = payloadRaw as Record<string, unknown>;
    const algorithm = obj.algorithm === "AES-GCM" ? "AES-GCM" : null;
    const version = obj.version === 1 ? 1 : null;
    const salt = typeof obj.salt === "string" ? obj.salt : null;
    const iv = typeof obj.iv === "string" ? obj.iv : null;
    const ciphertext = typeof obj.ciphertext === "string" ? obj.ciphertext : null;
    if (!algorithm || !version || !salt || !iv || !ciphertext) {
      continue;
    }
    importedProfileData[p.id] = {
      version,
      algorithm,
      salt,
      iv,
      ciphertext,
      scope: "legacy-appkey",
    };
  }


  const existingProfiles = Array.isArray(target.index.profiles) ? target.index.profiles : [];
  const existingIds = new Set(existingProfiles.map((p) => p.id));
  const mergedProfiles = [...existingProfiles];
  for (const p of importedProfiles) {
    if (!existingIds.has(p.id)) {
      mergedProfiles.push(p);
    }
  }

  const mergedProfileData: Record<ProfileId, EncryptedPayload | undefined> = { ...(target.profileData ?? {}) };
  let mergedDataCount = 0;
  for (const [id, payload] of Object.entries(importedProfileData) as Array<[ProfileId, EncryptedPayload | undefined]>) {
    if (payload && !mergedProfileData[id]) {
      mergedProfileData[id] = payload;
      mergedDataCount += 1;
    }
  }

  // Prefer existing currentProfileId if it is still valid.
  const existingCurrent = target.index.currentProfileId;
  const legacyCurrent =
    typeof idxObj.currentProfileId === "string" && mergedProfiles.some((p) => p.id === idxObj.currentProfileId)
      ? (idxObj.currentProfileId as ProfileId)
      : importedProfiles[0].id;

  const currentProfileId =
    existingCurrent && mergedProfiles.some((p) => p.id === existingCurrent) ? existingCurrent : legacyCurrent;

  const addedProfiles = mergedProfiles.length - existingProfiles.length;
  if (addedProfiles <= 0 && mergedDataCount <= 0) {
    return false;
  }

  target.index = {
    currentProfileId,
    profiles: mergedProfiles,
  };
  target.profileData = mergedProfileData;
  target.meta.revision = Math.max(1, (target.meta.revision ?? 0) + 1);
  target.updatedAt = nowIso();
  return true;
}

export async function initDbAuto(defaultLang: Language): Promise<void> {
  if (db || isInitializing) {
    return;
  }
  isInitializing = true;
  notify();

  // Try persisted handle and snapshot first.
  await tryRestoreHandle();
  const snapshotLoaded = await tryLoadFromSnapshot(defaultLang);
  if (!snapshotLoaded) {
    await tryLoadFromHandle(defaultLang);
  }

  // If nothing is loaded, create an empty DB in memory.
  if (!db) {
    db = createEmptyDb(nowIso(), defaultLang);
    isDirty = true;
    lastSyncedAt = null;
    conflicts = 0;
    fileLabel = fileLabel ?? "traeky-db.sqlite";
  }

  // Migrate legacy localStorage profiles into the DB if the DB is empty.
  const migrated = migrateLegacyLocalStorageIntoDb(db);
  if (migrated) {
    isDirty = true;
    lastSyncedAt = null;
  }

  // Persist a snapshot so Firefox has storage across reloads.
  try {
    const snapshot = await serializeDbToSqlite(db);
    await idbSet(IDB_SNAPSHOT_KEY, snapshot);
    if (fileLabel) {
      await idbSet(IDB_FILE_LABEL_KEY, fileLabel);
    }
  } catch {
    // ignore
  }

  isInitializing = false;
  notify();
}

export async function openDbInteractive(fallbackLang: Language): Promise<void> {
  const file = await pickFileWithFallback();
  if (!file) return;
  const loaded = await loadDbFromFile(file, fallbackLang);
  db = loaded;
  isDirty = false;
  lastSyncedAt = nowIso();
  conflicts = 0;
  fileLabel = file.name;
  try {
    await idbSet(IDB_FILE_LABEL_KEY, fileLabel);
  } catch {
    // ignore
  }
  try {
    await idbSet(IDB_SNAPSHOT_KEY, await serializeDbToSqlite(loaded));
  } catch {
    // ignore
  }
  notify();
}

export async function syncDbNow(): Promise<void> {
  if (!db) {
    throw new Error("Database not loaded");
  }
  const binary = await serializeDbToSqlite(db);

  const suggested = fileLabel ?? "traeky-db.sqlite";
  if (supportsFileSystemAccess() && fileHandle) {
    await saveViaHandle(fileHandle, binary);
  } else {
    const w = window as WindowWithFsAccess;
    if (typeof w.showSaveFilePicker === "function") {
      const handle = await w.showSaveFilePicker({
        suggestedName: suggested,
        types: [
          {
            description: "Traeky DB",
            accept: {
              "application/x-sqlite3": [".sqlite", ".db"],
              "application/octet-stream": [".sqlite", ".db", ".traeky"],
            },
          },
        ],
      });
      fileHandle = handle;
      try {
        await idbSet(IDB_HANDLE_KEY, handle);
      } catch {
        // ignore
      }
      await saveViaHandle(handle, binary);
    } else {
      saveViaDownload(suggested, binary);
    }
  }

  isDirty = false;
  lastSyncedAt = nowIso();
  conflicts = 0;
  fileLabel = suggested;
  try {
    await idbSet(IDB_SNAPSHOT_KEY, binary);
    await idbSet(IDB_FILE_LABEL_KEY, suggested);
  } catch {
    // ignore
  }
  notify();
}

export async function createNewDbInteractive(defaultLang: Language): Promise<void> {
  db = createEmptyDb(nowIso(), defaultLang);
  isDirty = true;
  lastSyncedAt = null;
  conflicts = 0;
  fileLabel = "traeky-db.sqlite";
  notify();
  await syncDbNow();
}

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
 * - If updatedAt is equal but payload differs, we keep the local version and record a conflict.
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
  const allIds = new Set<string>([
    ...local.index.profiles.map((p) => p.id),
    ...imported.index.profiles.map((p) => p.id),
  ]);

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

  if (local.index.currentProfileId && !mergedData[local.index.currentProfileId]) {
    local.index.currentProfileId = mergedProfiles.length ? mergedProfiles[0].id : null;
  }

  conflicts = conflictCount;
  markDbDirty();
}

export async function importDbInteractive(fallbackLang: Language): Promise<void> {
  const file = await pickFileWithFallback();
  if (!file) return;
  const imported = await loadDbFromFile(file, fallbackLang);
  mergeImportedDb(imported);
}
