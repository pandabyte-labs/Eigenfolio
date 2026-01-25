import type { AppConfig, Transaction } from "../domain/types";
import {
  DEFAULT_HOLDING_PERIOD_DAYS,
  DEFAULT_UPCOMING_WINDOW_DAYS,
} from "../domain/config";
import {
  CURRENT_CSV_SCHEMA_VERSION,
  CSV_SCHEMA_VERSION_COLUMN,
} from "../data/csvSchema";
import type { EncryptedPayload } from "../crypto/cryptoService";
import {
  decryptJsonWithPassphrase,
  encryptJsonWithPassphrase,
} from "../crypto/cryptoService";
import type { TraekyDb } from "./traekyDb";
import type { ProfileId, ProfileSummary } from "../auth/profileTypes";

// Legacy localStorage schema (<= 26.1.16.x)
const LS_PROFILES_INDEX_KEY = "traeky:profiles:index";
const PROFILE_DATA_PREFIX = "traeky:profile:";
const PROFILE_DATA_SUFFIX = ":data";
const PROFILE_PIN_INDEX_KEY = "traeky:profiles-pin-index";

const MIGRATION_CSV_BACKUP_DONE_KEY = "traeky:migration:legacy_csv_backup_done";

type LegacyProfilesIndex = {
  currentProfileId: ProfileId | null;
  profiles: ProfileSummary[];
};

type ProfilePinIndex = Record<string, string>;

type LegacyProfileDataPayloadV1 = {
  version: 1;
  transactions?: Transaction[];
  nextTransactionId?: number;
  config?: AppConfig;
};

type MigratedProfileDataPayloadV2 = {
  version: 2;
  transactions: Transaction[];
  nextTransactionId: number;
  config: AppConfig;
  // Optional caches introduced in later versions.
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

function readJson<T>(key: string): T | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function buildProfileDataKey(profileId: ProfileId): string {
  return `${PROFILE_DATA_PREFIX}${profileId}${PROFILE_DATA_SUFFIX}`;
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
  };
}

function getLegacyEncryptionKey(): string | null {
  const env = import.meta.env as Record<string, unknown>;
  const key =
    (env.VITE_PROFILE_ENCRYPTION_KEY as string | undefined) ??
    (env.TRAEKY_PROFILE_ENCRYPTION_KEY as string | undefined);
  return key && key.length > 0 ? key : null;
}

function hasLegacyMultiProfileData(): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    return !!storage.getItem(LS_PROFILES_INDEX_KEY);
  } catch {
    return false;
  }
}

function shouldPrepareBackups(): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    return storage.getItem(MIGRATION_CSV_BACKUP_DONE_KEY) !== "1";
  } catch {
    return false;
  }
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
};

/**
 * Migrates legacy multi-profile localStorage data into the current DB file.
 *
 * Safety properties:
 * - Never deletes any localStorage keys.
 * - Only imports when the DB currently has no profiles.
 * - Creates CSV backups in-memory; they will be offered for download on the next user-triggered sync.
 */
export async function migrateLegacyLocalStorageIntoDb(db: TraekyDb): Promise<LegacyMigrationResult> {
  if (!hasLegacyMultiProfileData()) {
    return { migratedProfiles: 0, backupsPrepared: 0, skipped: true };
  }

  if (db.index.profiles.length > 0) {
    return { migratedProfiles: 0, backupsPrepared: 0, skipped: true };
  }

  const storage = getStorage();
  if (!storage) {
    return { migratedProfiles: 0, backupsPrepared: 0, skipped: true };
  }

  // We intentionally do NOT set a persistent "imported" flag.
  // If the user reloads before syncing their DB file, we want to re-import
  // legacy localStorage so profiles remain visible.

  const legacyIndex = readJson<LegacyProfilesIndex>(LS_PROFILES_INDEX_KEY);
  if (!legacyIndex || !Array.isArray(legacyIndex.profiles) || legacyIndex.profiles.length === 0) {
    return { migratedProfiles: 0, backupsPrepared: 0, skipped: true };
  }

  const pinIndex = readJson<ProfilePinIndex>(PROFILE_PIN_INDEX_KEY) ?? {};
  const legacyKey = getLegacyEncryptionKey();

  // We can only re-encrypt safely if we can decrypt legacy payloads.
  // If the legacy key is not present, we import encrypted blobs as-is (so no data loss),
  // but users will need the legacy key to log in and re-encrypt.

  const nextProfiles: ProfileSummary[] = [];
  const shouldBackUp = shouldPrepareBackups();
  let backupCount = 0;
  let migratedCount = 0;

  for (const meta of legacyIndex.profiles) {
    if (!meta || typeof meta.id !== "string") {
      continue;
    }

    const encrypted = readJson<EncryptedPayload>(buildProfileDataKey(meta.id));
    if (!encrypted) {
      continue;
    }

    // Default path: decrypt legacy payload using fixed key, then re-encrypt with stored pinHash.
    const pinHash = typeof pinIndex[meta.id] === "string" ? pinIndex[meta.id] : null;

    if (legacyKey && pinHash) {
      try {
        const decrypted = await decryptJsonWithPassphrase<LegacyProfileDataPayloadV1>(encrypted, legacyKey);
        const normalized = normalizeLegacyPayload(decrypted);
        const reEncrypted = await encryptJsonWithPassphrase(normalized, pinHash);
        db.profileData[meta.id] = reEncrypted;

        if (shouldBackUp && normalized.transactions.length > 0) {
          pendingCsvBackups.push(buildCsv(meta.name ?? meta.id, normalized.transactions, normalized.config));
          backupCount += 1;
        }

        nextProfiles.push(meta);
        migratedCount += 1;
        continue;
      } catch {
        // Fall through to best-effort import.
      }
    }

    // Best-effort import: keep ciphertext (still safe) so it can be recovered.
    // This may require the legacy encryption key for a future migration.
    db.profileData[meta.id] = encrypted;
    nextProfiles.push(meta);
    migratedCount += 1;
  }

  if (nextProfiles.length === 0) {
    return { migratedProfiles: 0, backupsPrepared: 0, skipped: true };
  }

  db.index.profiles = nextProfiles;
  db.index.currentProfileId =
    legacyIndex.currentProfileId && db.profileData[legacyIndex.currentProfileId]
      ? legacyIndex.currentProfileId
      : nextProfiles[0].id;

  return { migratedProfiles: migratedCount, backupsPrepared: backupCount, skipped: false };
}
