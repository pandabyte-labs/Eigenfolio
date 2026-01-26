import type { EncryptedPayload } from "../crypto/cryptoService";
import { decryptJsonWithPassphrase } from "../crypto/cryptoService";
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

type LegacyProfilesIndex = {
  currentProfileId: ProfileId | null;
  profiles: ProfileSummary[];
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

function looksLikeProfilesIndex(value: unknown): value is LegacyProfilesIndex {
  if (!isObject(value)) return false;
  const profiles = (value as Record<string, unknown>).profiles;
  if (!Array.isArray(profiles) || profiles.length === 0) return false;
  return profiles.every((p) => {
    if (!isObject(p)) return false;
    return typeof p.id === "string" && typeof p.name === "string";
  });
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
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
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
  encryptedPayloadsByKey: Map<string, EncryptedPayload>;  profileDataMaps: Record<string, EncryptedPayload>[];
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

    if (looksLikeProfilesIndex(parsed)) {
      const candidate = parsed;
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
    encryptedPayloadsByKey,    profileDataMaps,
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
  if (db.index.profiles.length > 0) {
    return { migratedProfiles: 0, backupsPrepared: 0, skipped: true, source: "none" };
  }

  const storage = getStorage();
  if (!storage) {
    return { migratedProfiles: 0, backupsPrepared: 0, skipped: true, source: "none" };
  }

  const scan = scanLocalStorage(storage);

  if (scan.dbSnapshot && scan.dbSnapshot.index.profiles.length > 0) {
    // Direct import of stored DB snapshot.
    db.createdAt = scan.dbSnapshot.createdAt;
    db.updatedAt = scan.dbSnapshot.updatedAt;
    db.index = scan.dbSnapshot.index;
    db.profileData = scan.dbSnapshot.profileData;
    // Keep current db.ui when snapshot lacks ui/meta.
    if (scan.dbSnapshot.ui) {
      db.ui = scan.dbSnapshot.ui;
    }
    if (scan.dbSnapshot.meta) {
      db.meta = scan.dbSnapshot.meta;
    }
    return {
      migratedProfiles: scan.dbSnapshot.index.profiles.length,
      backupsPrepared: 0,
      skipped: false,
      source: "db-snapshot",
    };
  }

  if (!scan.profilesIndex || scan.profilesIndex.profiles.length === 0) {
    return { migratedProfiles: 0, backupsPrepared: 0, skipped: true, source: "none" };
  }

  const legacyKey = getLegacyEncryptionKey();
  const doBackups = shouldPrepareBackups(storage);

  const nextProfiles: ProfileSummary[] = [];
  let migratedCount = 0;
  let backupCount = 0;

  for (const meta of scan.profilesIndex.profiles) {
    if (!meta || typeof meta.id !== "string") continue;

    const encrypted = pickEncryptedPayloadForProfile(meta.id, scan.encryptedPayloadsByKey, scan.profileDataMaps);
    if (!encrypted) continue;

    db.profileData[meta.id] = encrypted;
    nextProfiles.push(meta);
    migratedCount += 1;

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
  db.index.currentProfileId =
    scan.profilesIndex.currentProfileId && db.profileData[scan.profilesIndex.currentProfileId]
      ? scan.profilesIndex.currentProfileId
      : nextProfiles[0].id;

  return { migratedProfiles: migratedCount, backupsPrepared: backupCount, skipped: false, source: "index+payloads" };
}
