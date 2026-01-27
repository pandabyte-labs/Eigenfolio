import type { EncryptedPayload } from "../crypto/cryptoService";
import { decryptJsonWithPassphrase, encryptJsonWithPassphrase } from "../crypto/cryptoService";
import type { AppConfig, Transaction } from "../domain/types";
import {
  DEFAULT_HOLDING_PERIOD_DAYS,
  DEFAULT_UPCOMING_WINDOW_DAYS,
} from "../domain/config";
import {
  CURRENT_CSV_SCHEMA_VERSION,
  CSV_SCHEMA_VERSION_COLUMN,
} from "../data/csvSchema";
import type { ProfileId, ProfileSummary } from "../auth/profileTypes";
import type { TraekyDb } from "./traekyDb";

const MIGRATION_CSV_BACKUP_DONE_KEY = "traeky:migration:legacy_csv_backup_done";

const LEGACY_TRANSACTIONS_KEY = "traeky:transactions";
const LEGACY_NEXT_ID_KEY = "traeky:next-tx-id";
const LEGACY_CONFIG_KEY = "traeky:app-config";
const LEGACY_SINGLE_PROFILE_ID = "legacy-profile";


type LegacyProfilesIndex = {
  currentProfileId: ProfileId | null;
  profiles: ProfileSummary[];
};

type LegacyProfilesIndexLike = {
  currentProfileId?: unknown;
  current_profile_id?: unknown;
  activeProfileId?: unknown;
  profiles?: unknown;
};

type LegacyProfileDataPayloadV1 = {
  version: 1;
  transactions?: Transaction[];
  nextTransactionId?: number;
  config?: AppConfig;
  priceCache?: unknown;
  historicalPriceCache?: unknown;
};

type MigratedProfileDataPayloadV2 = {
  version: 2;
  transactions: Transaction[];
  nextTransactionId: number;
  config: AppConfig;
  priceCache?: unknown;
  historicalPriceCache?: unknown;
};

type PendingCsvBackup = {
  filename: string;
  csv: string;
};

let pendingCsvBackups: PendingCsvBackup[] = [];

function getStorage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // ignore
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function looksLikeEncryptedPayload(value: unknown): value is EncryptedPayload {
  if (!isObject(value)) return false;
  return (
    value.version === 1 &&
    value.algorithm === "AES-GCM" &&
    typeof value.salt === "string" &&
    typeof value.iv === "string" &&
    typeof value.ciphertext === "string"
  );
}

function looksLikeTraekyDb(value: unknown): value is TraekyDb {
  if (!isObject(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (!isObject(v.index) || !isObject(v.profileData)) return false;
  const index = v.index as Record<string, unknown>;
  if (!Array.isArray(index.profiles)) return false;
  return true;
}

function safeJsonParse(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "string") {
      const trimmed = parsed.trim();
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          return JSON.parse(trimmed) as unknown;
        } catch {
          return parsed;
        }
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

function readLegacyTransactions(storage: Storage): Transaction[] {
  try {
    const raw = storage.getItem(LEGACY_TRANSACTIONS_KEY);
    if (!raw) return [];
    const parsed = safeJsonParse(raw);
    return Array.isArray(parsed) ? (parsed as Transaction[]) : [];
  } catch {
    return [];
  }
}

function readLegacyNextId(storage: Storage): number | null {
  try {
    const raw = storage.getItem(LEGACY_NEXT_ID_KEY);
    if (!raw) return null;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readLegacyConfig(storage: Storage): AppConfig | null {
  try {
    const raw = storage.getItem(LEGACY_CONFIG_KEY);
    if (!raw) return null;
    const parsed = safeJsonParse(raw);
    if (!isObject(parsed)) return null;
    const cfg = parsed as Record<string, unknown>;
    const baseCurrency = cfg.base_currency === "USD" ? "USD" : "EUR";
    const holding =
      typeof cfg.holding_period_days === "number" && Number.isFinite(cfg.holding_period_days)
        ? cfg.holding_period_days
        : DEFAULT_HOLDING_PERIOD_DAYS;
    const upcoming =
      typeof cfg.upcoming_holding_window_days === "number" &&
      Number.isFinite(cfg.upcoming_holding_window_days)
        ? cfg.upcoming_holding_window_days
        : DEFAULT_UPCOMING_WINDOW_DAYS;
    const priceFetchEnabled = typeof cfg.price_fetch_enabled === "boolean" ? cfg.price_fetch_enabled : true;
    const coingeckoApiKey = typeof cfg.coingecko_api_key === "string" ? cfg.coingecko_api_key : null;

    return {
      holding_period_days: holding,
      upcoming_holding_window_days: upcoming,
      base_currency: baseCurrency,
      price_fetch_enabled: priceFetchEnabled,
      coingecko_api_key: coingeckoApiKey,
    };
  } catch {
    return null;
  }
}

function hasLegacySingleProfileData(storage: Storage): boolean {
  try {
    return !!storage.getItem(LEGACY_TRANSACTIONS_KEY) || !!storage.getItem(LEGACY_CONFIG_KEY) || !!storage.getItem(LEGACY_NEXT_ID_KEY);
  } catch {
    return false;
  }
}

}

function normalizeProfileSummary(value: unknown): ProfileSummary | null {
  if (!isObject(value)) return null;
  const v = value as Record<string, unknown>;
  const id =
    (typeof v.id === "string" && v.id) ||
    (typeof v.profileId === "string" && v.profileId) ||
    (typeof v.profile_id === "string" && v.profile_id) ||
    "";
  const name =
    (typeof v.name === "string" && v.name) ||
    (typeof v.profileName === "string" && v.profileName) ||
    (typeof v.profile_name === "string" && v.profile_name) ||
    (typeof v.label === "string" && v.label) ||
    "";
  if (!id || !name) return null;
  const createdAt = typeof v.createdAt === "string" ? v.createdAt : typeof v.created_at === "string" ? v.created_at : new Date().toISOString();
  const updatedAt = typeof v.updatedAt === "string" ? v.updatedAt : typeof v.updated_at === "string" ? v.updated_at : createdAt;
  return { id, name, createdAt, updatedAt };
}

function normalizeProfilesIndex(value: unknown): LegacyProfilesIndex | null {
  if (!isObject(value)) return null;
  const v = value as LegacyProfilesIndexLike;
  const profilesRaw = v.profiles;
  if (!Array.isArray(profilesRaw) || profilesRaw.length === 0) return null;
  const profiles = profilesRaw.map(normalizeProfileSummary).filter((p): p is ProfileSummary => !!p);
  if (profiles.length === 0) return null;

  const currentRaw =
    (v.currentProfileId as unknown) ?? (v.current_profile_id as unknown) ?? (v.activeProfileId as unknown) ?? null;
  const currentProfileId = typeof currentRaw === "string" && currentRaw.length > 0 ? (currentRaw as ProfileId) : null;

  return {
    currentProfileId,
    profiles,
  };
}

function createDefaultConfig(): AppConfig {
  return {
    holding_period_days: DEFAULT_HOLDING_PERIOD_DAYS,
    upcoming_holding_window_days: DEFAULT_UPCOMING_WINDOW_DAYS,
    base_currency: "EUR",
    price_fetch_enabled: true,
    coingecko_api_key: null,
  };
}

function normalizeLegacyPayload(value: LegacyProfileDataPayloadV1): MigratedProfileDataPayloadV2 {
  return {
    version: 2,
    transactions: Array.isArray(value.transactions) ? value.transactions : [],
    nextTransactionId:
      typeof value.nextTransactionId === "number" && Number.isFinite(value.nextTransactionId)
        ? value.nextTransactionId
        : 1,
    config: value.config ?? createDefaultConfig(),
    priceCache: value.priceCache,
    historicalPriceCache: value.historicalPriceCache,
  };
}

function getLegacyEncryptionKey(): string | null {
  const env = import.meta.env as Record<string, unknown>;
  const key =
    (env.VITE_PROFILE_ENCRYPTION_KEY as string | undefined) ??
    (env.TRAEKY_PROFILE_ENCRYPTION_KEY as string | undefined);
  return key && key.length > 0 ? key : null;
}

function escapeCell(value: string): string {
  return `"${value.replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
}

function buildCsv(profileName: string, transactions: Transaction[], config: AppConfig): PendingCsvBackup {
  const headers = [
    "asset_symbol",
    "tx_type",
    "amount",
    "timestamp",
    "price_fiat",
    "fiat_currency",
    "fiat_value",
    "value_eur",
    "value_usd",
    "source",
    "note",
    "tx_id",
    "linked_tx_prev_id",
    "linked_tx_next_id",
    CSV_SCHEMA_VERSION_COLUMN,
    "holding_period_days",
    "base_currency",
  ];

  const rows = transactions.map((tx) => [
    tx.asset_symbol ?? "",
    tx.tx_type ?? "",
    tx.amount != null ? String(tx.amount) : "",
    tx.timestamp ?? "",
    tx.price_fiat != null ? String(tx.price_fiat) : "",
    tx.fiat_currency ?? "",
    tx.fiat_value != null ? String(tx.fiat_value) : "",
    tx.value_eur != null ? String(tx.value_eur) : "",
    tx.value_usd != null ? String(tx.value_usd) : "",
    tx.source ?? "",
    tx.note ?? "",
    tx.tx_id ?? "",
    tx.linked_tx_prev_id != null ? String(tx.linked_tx_prev_id) : "",
    tx.linked_tx_next_id != null ? String(tx.linked_tx_next_id) : "",
    String(CURRENT_CSV_SCHEMA_VERSION),
    String(config.holding_period_days ?? DEFAULT_HOLDING_PERIOD_DAYS),
    config.base_currency ?? "EUR",
  ]);

  const csvLines = [headers.join(","), ...rows.map((r) => r.map(escapeCell).join(","))];

  const profilePart = (profileName.trim() || "profile").replace(/[^a-z0-9_-]+/gi, "_") || "profile";
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    filename: `Traeky_MigrationBackup_${profilePart}_${stamp}.csv`,
    csv: csvLines.join("\n"),
  };
}

function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

export function hasPendingLegacyCsvBackups(): boolean {
  return pendingCsvBackups.length > 0;
}

export function downloadPendingLegacyCsvBackups(): void {
  if (pendingCsvBackups.length === 0) return;
  for (const item of pendingCsvBackups) {
    try {
      downloadCsv(item.filename, item.csv);
    } catch {
      // ignore
    }
  }
  pendingCsvBackups = [];
  const storage = getStorage();
  if (storage) {
    try {
      storage.setItem(MIGRATION_CSV_BACKUP_DONE_KEY, "1");
    } catch {
      // ignore
    }
  }
}

export type LegacyMigrationResult = {
  migratedProfiles: number;
  backupsPrepared: number;
  skipped: boolean;
  source: "none" | "db-snapshot" | "index+payloads";
};

function shouldPrepareBackups(storage: Storage): boolean {
  try {
    return storage.getItem(MIGRATION_CSV_BACKUP_DONE_KEY) !== "1";
  } catch {
    return false;
  }
}

type ScanResult = {
  dbSnapshot: TraekyDb | null;
  profilesIndex: LegacyProfilesIndex | null;
  encryptedPayloadsByKey: Map<string, EncryptedPayload>;
  profileDataMaps: Record<string, EncryptedPayload>[];
};

function scanLocalStorage(storage: Storage): ScanResult {
  let dbSnapshot: TraekyDb | null = null;
  let profilesIndex: LegacyProfilesIndex | null = null;
  const encryptedPayloadsByKey = new Map<string, EncryptedPayload>();
  const profileDataMaps: Record<string, EncryptedPayload>[] = [];

  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key) continue;
    const raw = storage.getItem(key);
    if (!raw) continue;
    const parsed = safeJsonParse(raw);
    if (!parsed) continue;

    if (!dbSnapshot && looksLikeTraekyDb(parsed)) {
      dbSnapshot = parsed;
      continue;
    }

    const candidateIndex = normalizeProfilesIndex(parsed);
    if (candidateIndex) {
      const candidate = candidateIndex;
      if (!profilesIndex || candidate.profiles.length > profilesIndex.profiles.length) {
        profilesIndex = candidate;
      }
      continue;
    }

    if (looksLikeEncryptedPayload(parsed)) {
      encryptedPayloadsByKey.set(key, parsed);
      continue;
    }

    // Potential profileData map: { [profileId]: EncryptedPayload }
    if (isObject(parsed)) {
      const values = Object.values(parsed);
      const encryptedValues = values.filter(looksLikeEncryptedPayload);
      if (encryptedValues.length >= 1) {
        const asMap: Record<string, EncryptedPayload> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (looksLikeEncryptedPayload(v)) {
            asMap[k] = v;
          }
        }
        if (Object.keys(asMap).length > 0) {
          profileDataMaps.push(asMap);
        }
      }
    }
  }

  return {
    dbSnapshot,
    profilesIndex,
    encryptedPayloadsByKey,
    profileDataMaps,
  };
}

function pickEncryptedPayloadForProfile(
  profileId: ProfileId,
  encryptedPayloadsByKey: Map<string, EncryptedPayload>,
  profileDataMaps: Record<string, EncryptedPayload>[],
): EncryptedPayload | null {
  for (const m of profileDataMaps) {
    if (m[profileId] && looksLikeEncryptedPayload(m[profileId])) {
      return m[profileId];
    }
  }

  const candidates: { key: string; payload: EncryptedPayload }[] = [];
  for (const [key, payload] of encryptedPayloadsByKey.entries()) {
    if (key.includes(profileId)) {
      candidates.push({ key, payload });
    }
  }
  if (candidates.length === 0) {
    return null;
  }

  // Prefer keys that end with the id, then shortest key (most specific).
  candidates.sort((a, b) => {
    const aEnds = a.key.endsWith(profileId) ? 0 : 1;
    const bEnds = b.key.endsWith(profileId) ? 0 : 1;
    if (aEnds !== bEnds) return aEnds - bEnds;
    return a.key.length - b.key.length;
  });

  return candidates[0].payload;
}

/**
 * Migrates legacy localStorage data into the in-memory DB.
 *
 * Safety properties:
 * - Never deletes any localStorage keys.
 * - Only imports when the current DB has no profiles.
 * - Best-effort: imports encrypted blobs even when the legacy decryption key is unknown.
 * - Optionally prepares CSV backups when the legacy global key can decrypt the payloads.
 */
export async function migrateLegacyLocalStorageIntoDb(db: TraekyDb): Promise<LegacyMigrationResult> {
  const storage = getStorage();
  if (!storage) {
    return { migratedProfiles: 0, backupsPrepared: 0, skipped: true, source: "none" };
  }

  const scan = scanLocalStorage(storage);

  if (scan.dbSnapshot && scan.dbSnapshot.index.profiles.length > 0) {
    const existingIds = new Set(db.index.profiles.map((p) => p.id));
    const incomingIds = new Set(scan.dbSnapshot.index.profiles.map((p) => p.id));
    const shouldReplace = db.index.profiles.length === 0;

    if (shouldReplace) {
      db.createdAt = scan.dbSnapshot.createdAt;
      db.updatedAt = scan.dbSnapshot.updatedAt;
      db.index = scan.dbSnapshot.index;
      db.profileData = scan.dbSnapshot.profileData;
      if (scan.dbSnapshot.ui) {
        db.ui = scan.dbSnapshot.ui;
      }
      if (scan.dbSnapshot.meta) {
        db.meta = scan.dbSnapshot.meta;
      }
    } else {
      const nextProfiles = [...db.index.profiles];
      for (const p of scan.dbSnapshot.index.profiles) {
        if (existingIds.has(p.id)) continue;
        nextProfiles.push(p);
        db.profileData[p.id] = scan.dbSnapshot.profileData[p.id];
      }
      db.index.profiles = nextProfiles;
      if (db.index.currentProfileId && !db.profileData[db.index.currentProfileId]) {
        db.index.currentProfileId = nextProfiles.length ? nextProfiles[0].id : null;
      }
    }
    return {
      migratedProfiles: shouldReplace
        ? scan.dbSnapshot.index.profiles.length
        : Array.from(incomingIds).filter((id) => !existingIds.has(id)).length,
      backupsPrepared: 0,
      skipped: false,
      source: "db-snapshot",
    };
  }

  if (!scan.profilesIndex || scan.profilesIndex.profiles.length === 0) {
    if (db.index.profiles.length === 0 && hasLegacySingleProfileData(storage)) {
      const legacyKey = getLegacyEncryptionKey();
      if (!legacyKey) {
        return { migratedProfiles: 0, backupsPrepared: 0, skipped: true, source: "none" };
      }
      const transactions = readLegacyTransactions(storage);
      const nextId =
        readLegacyNextId(storage) ??
        (transactions.length
          ? transactions.reduce((acc, tx) => (tx.id && tx.id > acc ? tx.id : acc), 0) + 1
          : 1);
      const config = readLegacyConfig(storage) ?? createDefaultConfig();
      const payload: MigratedProfileDataPayloadV2 = {
        version: 2,
        transactions,
        nextTransactionId: nextId,
        config,
      };
      const encrypted = await encryptJsonWithPassphrase(payload, legacyKey);
      db.profileData[LEGACY_SINGLE_PROFILE_ID] = { ...encrypted, scope: "legacy-appkey" };
      const now = new Date().toISOString();
      db.index.profiles = [
        {
          id: LEGACY_SINGLE_PROFILE_ID,
          name: "Default",
          createdAt: now,
          updatedAt: now,
        },
      ];
      db.index.currentProfileId = LEGACY_SINGLE_PROFILE_ID;
      return { migratedProfiles: 1, backupsPrepared: 0, skipped: false, source: "index+payloads" };
    }
    return { migratedProfiles: 0, backupsPrepared: 0, skipped: true, source: "none" };
  }

  const legacyKey = getLegacyEncryptionKey();
  const doBackups = shouldPrepareBackups(storage);

  const existingIds = new Set(db.index.profiles.map((p) => p.id));
  const nextProfiles: ProfileSummary[] = [...db.index.profiles];
  let migratedCount = 0;
  let backupCount = 0;

  for (const meta of scan.profilesIndex.profiles) {
    if (!meta || typeof meta.id !== "string") continue;

    const encrypted = pickEncryptedPayloadForProfile(meta.id, scan.encryptedPayloadsByKey, scan.profileDataMaps);
    if (!encrypted) continue;

    if (!existingIds.has(meta.id)) {
      db.profileData[meta.id] = encrypted;
      nextProfiles.push(meta);
      migratedCount += 1;
    }

    if (doBackups && legacyKey) {
      try {
        const decrypted = await decryptJsonWithPassphrase<LegacyProfileDataPayloadV1>(encrypted, legacyKey);
        const normalized = normalizeLegacyPayload(decrypted);
        if (normalized.transactions.length > 0) {
          pendingCsvBackups.push(buildCsv(meta.name ?? meta.id, normalized.transactions, normalized.config));
          backupCount += 1;
        }
      } catch {
        // Not decryptable with legacy key; skip CSV.
      }
    }
  }

  if (nextProfiles.length === 0) {
    return { migratedProfiles: 0, backupsPrepared: 0, skipped: true, source: "none" };
  }

  db.index.profiles = nextProfiles;
  if (!db.index.currentProfileId || !db.profileData[db.index.currentProfileId]) {
    db.index.currentProfileId =
      scan.profilesIndex.currentProfileId && db.profileData[scan.profilesIndex.currentProfileId]
        ? scan.profilesIndex.currentProfileId
        : nextProfiles[0].id;
  }

  return { migratedProfiles: migratedCount, backupsPrepared: backupCount, skipped: false, source: "index+payloads" };
}
