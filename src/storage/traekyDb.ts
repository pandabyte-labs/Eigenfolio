import type { EncryptedPayload } from "../crypto/cryptoService";
import type { Language } from "../i18n";
import type { DataSourceMode } from "../data/localStore";
import type { ProfileId, ProfilesIndex } from "../auth/profileTypes";

export type TraekyDbVersion = 1;

export type TraekyUiSettings = {
  lang: Language;
  mode: DataSourceMode;
};

export type TraekyDbMeta = {
  revision: number;
};

export type TraekyDbV1 = {
  version: TraekyDbVersion;
  createdAt: string;
  updatedAt: string;
  index: ProfilesIndex;
  /**
   * Per-profile encrypted payload. The payload itself is encrypted with the
   * respective profile PIN-derived key.
   */
  profileData: Record<ProfileId, EncryptedPayload | undefined>;
  ui: TraekyUiSettings;
  meta: TraekyDbMeta;
};

export type TraekyDb = TraekyDbV1;

export function createEmptyDb(nowIso: string, lang: Language): TraekyDb {
  return {
    version: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    index: {
      currentProfileId: null,
      profiles: [],
    },
    profileData: {},
    ui: {
      lang,
      mode: "local-only",
    },
    meta: {
      revision: 1,
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

export function parseDb(jsonText: string): TraekyDb {
  const parsed = JSON.parse(jsonText) as unknown;
  if (!isObject(parsed) || parsed.version !== 1) {
    throw new Error("Unsupported database format");
  }
  // Minimal structural validation. We keep this permissive for forward compat.
  const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString();
  const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : createdAt;
  const indexRaw = isObject(parsed.index) ? parsed.index : {};
  const profilesRaw = Array.isArray((indexRaw as any).profiles) ? (indexRaw as any).profiles : [];
  const profiles = profilesRaw
    .filter((p: any) => p && typeof p.id === "string" && typeof p.name === "string")
    .map((p: any) => ({
      id: String(p.id),
      name: String(p.name),
      createdAt: typeof p.createdAt === "string" ? p.createdAt : createdAt,
      updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : updatedAt,
    }));
  const currentProfileId = typeof (indexRaw as any).currentProfileId === "string" ? (indexRaw as any).currentProfileId : null;

  const profileData = isObject(parsed.profileData) ? (parsed.profileData as Record<string, EncryptedPayload | undefined>) : {};

  const uiRaw = isObject(parsed.ui) ? parsed.ui : {};
  const lang = (uiRaw as any).lang === "de" ? "de" : "en";
  const mode = (uiRaw as any).mode === "local-only" ? "local-only" : "local-only";

  const metaRaw = isObject(parsed.meta) ? parsed.meta : {};
  const revision = typeof (metaRaw as any).revision === "number" && Number.isFinite((metaRaw as any).revision)
    ? Math.max(1, Math.trunc((metaRaw as any).revision))
    : 1;

  return {
    version: 1,
    createdAt,
    updatedAt,
    index: {
      currentProfileId,
      profiles,
    },
    profileData,
    ui: { lang, mode },
    meta: { revision },
  };
}

export function serializeDb(db: TraekyDb): string {
  return JSON.stringify(db);
}
