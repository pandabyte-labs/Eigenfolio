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

/**
 * Serialize the logical Traeky DB structure into a string.
 *
 * The UI/export flow currently treats the persisted DB file as an opaque
 * payload. Keeping these helpers preserves a stable internal API surface.
 */
export function serializeDb(db: TraekyDb): string {
  return JSON.stringify(db);
}

/**
 * Parse a serialized Traeky DB string into a typed structure.
 *
 * This is intentionally defensive: if the payload is malformed we return a
 * fresh empty DB rather than crashing the app.
 */
export function parseDb(serialized: string): TraekyDb {
  const nowIso = new Date().toISOString();
  const base = createEmptyDb(nowIso, "en" as Language);

  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== "object") return base;

    const obj = parsed as Partial<TraekyDbV1>;

    const indexRaw = obj.index as unknown;
    const index =
      indexRaw && typeof indexRaw === "object"
        ? {
            currentProfileId:
              (indexRaw as { currentProfileId?: ProfileId | null }).currentProfileId ??
              base.index.currentProfileId,
            profiles: Array.isArray((indexRaw as { profiles?: unknown }).profiles)
              ? ((indexRaw as { profiles: ProfilesIndex["profiles"] }).profiles ?? [])
              : base.index.profiles,
          }
        : base.index;

    const profileDataRaw = obj.profileData as unknown;
    const profileData =
      profileDataRaw && typeof profileDataRaw === "object" && !Array.isArray(profileDataRaw)
        ? (profileDataRaw as TraekyDbV1["profileData"])
        : base.profileData;

    const uiRaw = obj.ui as unknown;
    const ui =
      uiRaw && typeof uiRaw === "object"
        ? {
            lang: (uiRaw as { lang?: Language }).lang ?? base.ui.lang,
            mode: (uiRaw as { mode?: DataSourceMode }).mode ?? base.ui.mode,
          }
        : base.ui;

    const metaRaw = obj.meta as unknown;
    const meta =
      metaRaw && typeof metaRaw === "object"
        ? {
            revision:
              typeof (metaRaw as { revision?: unknown }).revision === "number"
                ? ((metaRaw as { revision: number }).revision ?? base.meta.revision)
                : base.meta.revision,
          }
        : base.meta;

    return {
      version: obj.version ?? base.version,
      createdAt: typeof obj.createdAt === "string" ? obj.createdAt : base.createdAt,
      updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : base.updatedAt,
      index,
      profileData,
      ui,
      meta,
    };
  } catch {
    return base;
  }
}

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
