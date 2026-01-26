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
