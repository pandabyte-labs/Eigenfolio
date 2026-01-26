import initSqlJs, { type Database as SqlDatabase, type SqlJsStatic } from "sql.js";

import type { EncryptedPayload } from "../crypto/cryptoService";
import type { Language } from "../i18n";
import type { DataSourceMode } from "../data/localStore";
import type { ProfileId, ProfilesIndex } from "../auth/profileTypes";
import type { TraekyDb } from "./traekyDb";

// Vite will bundle the WASM and provide a URL.
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";

let sqlJs: SqlJsStatic | null = null;

async function getSqlJs(): Promise<SqlJsStatic> {
  if (sqlJs) return sqlJs;
  sqlJs = await initSqlJs({ locateFile: () => wasmUrl });
  return sqlJs;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isFiniteInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.trunc(value) === value;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asLang(value: unknown, fallback: Language): Language {
  return value === "de" ? "de" : value === "en" ? "en" : fallback;
}

function asMode(value: unknown, fallback: DataSourceMode): DataSourceMode {
  // Currently only "local-only" is supported.
  return value === "local-only" ? "local-only" : fallback;
}

function exec(db: SqlDatabase, sql: string, params: unknown[] = []): void {
  db.run(sql, params as unknown as never[]);
}

function queryRows(db: SqlDatabase, sql: string, params: unknown[] = []): unknown[][] {
  const result = db.exec(sql, params as unknown as never[]);
  if (!result || result.length === 0) return [];
  return result[0]?.values as unknown[][];
}

function queryScalar(db: SqlDatabase, sql: string, params: unknown[] = []): unknown {
  const rows = queryRows(db, sql, params);
  if (!rows.length || !rows[0] || rows[0].length === 0) return null;
  return rows[0][0];
}

function createSchema(db: SqlDatabase): void {
  exec(
    db,
    [
      "PRAGMA journal_mode = MEMORY;",
      "PRAGMA foreign_keys = ON;",
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
      "CREATE TABLE IF NOT EXISTS ui_settings (id INTEGER PRIMARY KEY CHECK (id = 1), lang TEXT NOT NULL, mode TEXT NOT NULL);",
      "CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
      "CREATE TABLE IF NOT EXISTS profile_data (profile_id TEXT PRIMARY KEY, version INTEGER NOT NULL, algorithm TEXT NOT NULL, salt TEXT NOT NULL, iv TEXT NOT NULL, ciphertext TEXT NOT NULL, scope TEXT, updated_at TEXT NOT NULL, FOREIGN KEY(profile_id) REFERENCES profiles(id) ON DELETE CASCADE);",
    ].join("\n"),
  );
}

function putMeta(db: SqlDatabase, key: string, value: string): void {
  exec(db, "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value;", [
    key,
    value,
  ]);
}

function getMeta(db: SqlDatabase, key: string): string | null {
  const v = queryScalar(db, "SELECT value FROM meta WHERE key = ? LIMIT 1;", [key]);
  return typeof v === "string" ? v : null;
}

function upsertUi(db: SqlDatabase, lang: Language, mode: DataSourceMode): void {
  exec(
    db,
    "INSERT INTO ui_settings(id, lang, mode) VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET lang=excluded.lang, mode=excluded.mode;",
    [lang, mode],
  );
}

function readUi(db: SqlDatabase, fallbackLang: Language): { lang: Language; mode: DataSourceMode } {
  const rows = queryRows(db, "SELECT lang, mode FROM ui_settings WHERE id = 1 LIMIT 1;");
  if (!rows.length) {
    return { lang: fallbackLang, mode: "local-only" };
  }
  const [langRaw, modeRaw] = rows[0] ?? [];
  return {
    lang: asLang(langRaw, fallbackLang),
    mode: asMode(modeRaw, "local-only"),
  };
}

export async function serializeDbToSqlite(dbObj: TraekyDb): Promise<Uint8Array> {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  createSchema(db);

  const createdAt = dbObj.createdAt || nowIso();
  const updatedAt = dbObj.updatedAt || createdAt;
  const revision = Math.max(1, dbObj.meta?.revision ?? 1);
  putMeta(db, "version", "1");
  putMeta(db, "createdAt", createdAt);
  putMeta(db, "updatedAt", updatedAt);
  putMeta(db, "revision", String(revision));
  putMeta(db, "currentProfileId", dbObj.index.currentProfileId ?? "");
  upsertUi(db, dbObj.ui.lang, dbObj.ui.mode);

  // Profiles
  exec(db, "DELETE FROM profile_data;");
  exec(db, "DELETE FROM profiles;");

  for (const p of dbObj.index.profiles) {
    exec(db, "INSERT INTO profiles(id, name, created_at, updated_at) VALUES(?,?,?,?);", [
      p.id,
      p.name,
      p.createdAt,
      p.updatedAt,
    ]);
    const enc = dbObj.profileData[p.id];
    if (enc) {
      exec(
        db,
        "INSERT INTO profile_data(profile_id, version, algorithm, salt, iv, ciphertext, scope, updated_at) VALUES(?,?,?,?,?,?,?,?);",
        [
          p.id,
          enc.version,
          enc.algorithm,
          enc.salt,
          enc.iv,
          enc.ciphertext,
          enc.scope ?? null,
          p.updatedAt,
        ],
      );
    }
  }

  const binary = db.export();
  db.close();
  return binary;
}

function readProfilesIndex(db: SqlDatabase): ProfilesIndex {
  const profilesRows = queryRows(db, "SELECT id, name, created_at, updated_at FROM profiles ORDER BY created_at ASC;");
  const profiles = profilesRows
    .map((row) => {
      const [idRaw, nameRaw, createdRaw, updatedRaw] = row;
      const id = asString(idRaw, "");
      const name = asString(nameRaw, "");
      if (!id || !name) {
        return null;
      }
      return {
        id,
        name,
        createdAt: asString(createdRaw, nowIso()),
        updatedAt: asString(updatedRaw, asString(createdRaw, nowIso())),
      };
    })
    .filter((p): p is { id: ProfileId; name: string; createdAt: string; updatedAt: string } => !!p);

  const current = getMeta(db, "currentProfileId");
  const currentProfileId = current && profiles.some((p) => p.id === current) ? (current as ProfileId) : null;
  return { currentProfileId, profiles };
}

function readProfileData(db: SqlDatabase): Record<ProfileId, EncryptedPayload | undefined> {
  const rows = queryRows(
    db,
    "SELECT profile_id, version, algorithm, salt, iv, ciphertext, scope FROM profile_data;",
  );
  const out: Record<ProfileId, EncryptedPayload | undefined> = {};
  for (const row of rows) {
    const [idRaw, verRaw, algoRaw, saltRaw, ivRaw, ctRaw, scopeRaw] = row;
    const id = asString(idRaw, "");
    const algorithm = asString(algoRaw, "AES-GCM");
    const salt = asString(saltRaw, "");
    const iv = asString(ivRaw, "");
    const ciphertext = asString(ctRaw, "");
    const scope = scopeRaw === "legacy-appkey" ? "legacy-appkey" : scopeRaw === "pin" ? "pin" : undefined;

    if (!id || !salt || !iv || !ciphertext) continue;
    const version = isFiniteInt(verRaw) ? (verRaw as number) : 1;
    out[id] = {
      version: version === 1 ? 1 : 1,
      algorithm: algorithm === "AES-GCM" ? "AES-GCM" : "AES-GCM",
      salt,
      iv,
      ciphertext,
      scope,
    };
  }
  return out;
}

export async function parseDbFromSqlite(binary: Uint8Array, fallbackLang: Language): Promise<TraekyDb> {
  const SQL = await getSqlJs();
  const db = new SQL.Database(binary);
  createSchema(db);

  const createdAt = getMeta(db, "createdAt") ?? nowIso();
  const updatedAt = getMeta(db, "updatedAt") ?? createdAt;
  const revisionRaw = getMeta(db, "revision");
  const revision = revisionRaw ? Math.max(1, Math.trunc(Number(revisionRaw))) : 1;

  const index = readProfilesIndex(db);
  const profileData = readProfileData(db);
  const ui = readUi(db, fallbackLang);

  db.close();

  return {
    version: 1,
    createdAt,
    updatedAt,
    index,
    profileData,
    ui,
    meta: {
      revision: Number.isFinite(revision) ? revision : 1,
    },
  };
}
