import type { AppConfig, Transaction } from "../domain/types";
import { DEFAULT_HOLDING_PERIOD_DAYS, DEFAULT_UPCOMING_WINDOW_DAYS } from "../domain/config";
import type { EncryptedPayload } from "../crypto/cryptoService";
import { decryptJsonWithPassphrase } from "../crypto/cryptoService";
import { hashPin, encryptProfilePayload, decryptProfilePayload } from "./profileSecurity";
import { getDb, markDbDirty } from "../storage/dbStore";
import type { ProfileId, ProfileOverview, ProfileSummary, ProfilesIndex } from "./profileTypes";

export type { ProfileId, ProfileOverview, ProfileSummary };

// Support v1 (legacy) payloads and v2 (current) payloads.
type ProfileDataPayloadVersion = 1 | 2;

type ProfileDataPayload = {
  version: ProfileDataPayloadVersion;
  transactions: Transaction[];
  nextTransactionId: number;
  config: AppConfig;
  // Optional, encrypted along with the profile payload.
  priceCache?: Record<string, { eur?: number; usd?: number; fetched_at: number }>;
  historicalPriceCache?: Record<string, { eur?: number; usd?: number; fetched_at: number }>;
};

type ActiveProfileSession = {
  meta: ProfileSummary;
  pinHash: string;
  data: ProfileDataPayload;
};

const LEGACY_TRANSACTIONS_KEY = "traeky:transactions";
const LEGACY_NEXT_ID_KEY = "traeky:next-tx-id";
const LEGACY_CONFIG_KEY = "traeky:app-config";

function getLegacyEncryptionKey(): string | null {
  const env = import.meta.env as Record<string, unknown>;
  const key =
    (env.VITE_PROFILE_ENCRYPTION_KEY as string | undefined) ??
    (env.TRAEKY_PROFILE_ENCRYPTION_KEY as string | undefined);
  return key && key.length > 0 ? key : null;
}


let activeProfile: ActiveProfileSession | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function generateProfileId(): ProfileId {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

function createEmptyProfileData(): ProfileDataPayload {
  return {
    version: 2,
    transactions: [],
    nextTransactionId: 1,
    config: createDefaultConfig(),
  };
}

function getProfilesIndex(): ProfilesIndex {
  const db = getDb();
  return db.index;
}

function setProfilesIndex(index: ProfilesIndex): void {
  const db = getDb();
  db.index = index;
  markDbDirty();
}

function getEncryptedProfileData(profileId: ProfileId): EncryptedPayload | null {
  const db = getDb();
  return (db.profileData?.[profileId] as EncryptedPayload | undefined) ?? null;
}

function setEncryptedProfileData(profileId: ProfileId, encrypted: EncryptedPayload): void {
  const db = getDb();
  db.profileData[profileId] = encrypted;
  markDbDirty();
}

function removeEncryptedProfileData(profileId: ProfileId): void {
  const db = getDb();
  delete db.profileData[profileId];
  markDbDirty();
}

function getLegacyStorage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // ignore
  }
  return null;
}

function readLegacyJson<T>(key: string): T | null {
  const storage = getLegacyStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function readLegacyTransactions(): Transaction[] {
  const items = readLegacyJson<Transaction[]>(LEGACY_TRANSACTIONS_KEY);
  if (!items || !Array.isArray(items)) return [];
  return items;
}

function readLegacyNextId(): number | null {
  const storage = getLegacyStorage();
  if (!storage) return null;
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

function readLegacyConfig(): AppConfig | null {
  const cfg = readLegacyJson<AppConfig>(LEGACY_CONFIG_KEY);
  if (!cfg || typeof cfg !== "object") return null;
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
  const priceFetchEnabled =
    typeof cfg.price_fetch_enabled === "boolean" ? cfg.price_fetch_enabled : true;
  const coingeckoApiKey = typeof cfg.coingecko_api_key === "string" ? cfg.coingecko_api_key : null;

  return {
    holding_period_days: holding,
    upcoming_holding_window_days: upcoming,
    base_currency: baseCurrency,
    price_fetch_enabled: priceFetchEnabled,
    coingecko_api_key: coingeckoApiKey,
  };
}

function removeLegacyStorage(): void {
  // Intentionally no-op.
  // We never delete legacy localStorage keys automatically, to avoid accidental data loss.
}

function profileHasLegacyData(): boolean {
  const storage = getLegacyStorage();
  if (!storage) return false;
  try {
    return (
      !!storage.getItem(LEGACY_TRANSACTIONS_KEY) ||
      !!storage.getItem(LEGACY_CONFIG_KEY) ||
      !!storage.getItem(LEGACY_NEXT_ID_KEY)
    );
  } catch {
    return false;
  }
}

export function getProfileOverview(): ProfileOverview {
  const index = getProfilesIndex();
  return {
    profiles: index.profiles,
    hasLegacyData: profileHasLegacyData(),
  };
}

export function getActiveProfileSummary(): ProfileSummary | null {
  return activeProfile?.meta ?? null;
}

export function hasActiveProfileSession(): boolean {
  return !!activeProfile;
}

export function logoutActiveProfileSession(): void {
  activeProfile = null;
}

async function persistActiveProfile(): Promise<void> {
  if (!activeProfile) return;
  const payload: ProfileDataPayload = activeProfile.data;
  const encrypted: EncryptedPayload = await encryptProfilePayload(activeProfile.pinHash, payload);
  setEncryptedProfileData(activeProfile.meta.id, encrypted);

  const index = getProfilesIndex();
  const now = nowIso();
  const updatedProfiles = index.profiles.map((p) =>
    p.id === activeProfile!.meta.id ? { ...p, updatedAt: now, name: activeProfile!.meta.name } : p,
  );
  setProfilesIndex({
    currentProfileId: activeProfile.meta.id,
    profiles: updatedProfiles,
  });
}

export async function createInitialProfile(name: string, pin: string): Promise<ProfileSummary> {
  const trimmedName = name.trim() || "Default";
  const pinHash = await hashPin(pin);

  const index = getProfilesIndex();
  const id = generateProfileId();
  const now = nowIso();
  const meta: ProfileSummary = {
    id,
    name: trimmedName,
    createdAt: now,
    updatedAt: now,
  };

  let data: ProfileDataPayload;
  if (profileHasLegacyData() && index.profiles.length === 0) {
    const transactions = readLegacyTransactions();
    const nextId =
      readLegacyNextId() ??
      (transactions.length
        ? transactions.reduce((acc, tx) => (tx.id && tx.id > acc ? tx.id : acc), 0) + 1
        : 1);
    const config = readLegacyConfig() ?? createDefaultConfig();
    data = {
      version: 2,
      transactions,
      nextTransactionId: nextId,
      config,
    };
    removeLegacyStorage();
  } else {
    data = createEmptyProfileData();
  }

  activeProfile = { meta, pinHash, data };
  setProfilesIndex({
    currentProfileId: id,
    profiles: [...index.profiles, meta],
  });

  await persistActiveProfile();
  return meta;
}

export async function loginProfile(profileId: ProfileId, pin: string): Promise<ProfileSummary> {
  const index = getProfilesIndex();
  const meta = index.profiles.find((p) => p.id === profileId) ?? null;
  if (!meta) {
    throw new Error("Profile not found");
  }
  const pinHash = await hashPin(pin);
  const encrypted = getEncryptedProfileData(meta.id);
  if (!encrypted) {
    throw new Error("Profile data not found");
  }

  let data: ProfileDataPayload;
  try {
    data = await decryptProfilePayload<ProfileDataPayload>(pinHash, encrypted);
  } catch (err) {
    // Legacy compatibility: older builds encrypted profile payloads with a global app key.
    // If present, decrypt with that key and immediately re-encrypt with the user's PIN-derived key.
    const legacyKey = getLegacyEncryptionKey();
    if (!legacyKey) {
      throw err;
    }
    data = await decryptJsonWithPassphrase<ProfileDataPayload>(encrypted, legacyKey);
  }
  if (!data || (data.version !== 1 && data.version !== 2)) {
    throw new Error("Unsupported profile data version");
  }

  // Upgrade legacy payloads to v2 in memory.
  type LegacyProfileDataPayloadV1 = {
    version: 1;
    transactions?: Transaction[];
    nextTransactionId?: number;
    config?: AppConfig;
    priceCache?: ProfileDataPayload["priceCache"];
    historicalPriceCache?: ProfileDataPayload["historicalPriceCache"];
  };

  const normalized: ProfileDataPayload =
    data.version === 2
      ? data
      : (() => {
          const legacy = data as LegacyProfileDataPayloadV1;
          return {
            version: 2,
            transactions: legacy.transactions ?? [],
            nextTransactionId: legacy.nextTransactionId ?? 1,
            config: legacy.config ?? createDefaultConfig(),
            priceCache: legacy.priceCache,
            historicalPriceCache: legacy.historicalPriceCache,
          };
        })();
  activeProfile = { meta, pinHash, data: normalized };

  const now = nowIso();
  const updatedMeta: ProfileSummary = { ...meta, updatedAt: now };
  const updatedProfiles = index.profiles.map((p) => (p.id === meta.id ? updatedMeta : p));
  setProfilesIndex({
    currentProfileId: meta.id,
    profiles: updatedProfiles,
  });
  activeProfile.meta = updatedMeta;

  // Persist immediately to ensure v1 payloads are re-encrypted with the PIN.
  await persistActiveProfile();

  return updatedMeta;
}

export function getActiveProfileConfig(): AppConfig {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  return activeProfile.data.config;
}

export function setActiveProfileConfig(config: AppConfig): void {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  activeProfile.data.config = config;
  void persistActiveProfile();
}

export function getActiveProfileTransactions(): Transaction[] {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  return activeProfile.data.transactions;
}

export function setActiveProfileTransactions(items: Transaction[]): void {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  activeProfile.data.transactions = items;
  void persistActiveProfile();
}

export function getNextActiveProfileTxId(): number {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  const id = activeProfile.data.nextTransactionId;
  activeProfile.data.nextTransactionId = id + 1;
  void persistActiveProfile();
  return id;
}

export function getActiveProfilePriceCache(): ProfileDataPayload["priceCache"] {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  return activeProfile.data.priceCache;
}

export function setActiveProfilePriceCache(cache: ProfileDataPayload["priceCache"]): void {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  activeProfile.data.priceCache = cache;
  void persistActiveProfile();
}

export function getActiveProfileHistoricalPriceCache(): ProfileDataPayload["historicalPriceCache"] {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  return activeProfile.data.historicalPriceCache;
}

export function setActiveProfileHistoricalPriceCache(
  cache: ProfileDataPayload["historicalPriceCache"],
): void {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  activeProfile.data.historicalPriceCache = cache;
  void persistActiveProfile();
}

export async function createAdditionalProfile(name: string, pin: string): Promise<ProfileSummary> {
  const trimmedName = name.trim() || "Profile";
  const pinHash = await hashPin(pin);

  const index = getProfilesIndex();
  const id = generateProfileId();
  const now = nowIso();

  const meta: ProfileSummary = {
    id,
    name: trimmedName,
    createdAt: now,
    updatedAt: now,
  };

  const data = createEmptyProfileData();
  const encrypted: EncryptedPayload = await encryptProfilePayload(pinHash, data);
  setEncryptedProfileData(id, encrypted);

  setProfilesIndex({
    currentProfileId: id,
    profiles: [...index.profiles, meta],
  });

  activeProfile = { meta, pinHash, data };
  return meta;
}

export async function resetActiveProfileData(): Promise<void> {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  activeProfile.data = createEmptyProfileData();
  await persistActiveProfile();
}

export async function verifyActiveProfilePin(pin: string): Promise<boolean> {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  const candidateHash = await hashPin(pin);
  return candidateHash === activeProfile.pinHash;
}

export function renameActiveProfile(name: string): void {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return;
  }
  activeProfile.meta = {
    ...activeProfile.meta,
    name: trimmed,
  };
  void persistActiveProfile();
}

export async function changeActiveProfilePin(currentPin: string, newPin: string): Promise<void> {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  const currentHash = await hashPin(currentPin);
  if (currentHash !== activeProfile.pinHash) {
    throw new Error("Invalid current PIN");
  }
  const newHash = await hashPin(newPin);
  activeProfile.pinHash = newHash;
  await persistActiveProfile();
}

export function deleteActiveProfile(): void {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  const index = getProfilesIndex();
  const idToDelete = activeProfile.meta.id;

  removeEncryptedProfileData(idToDelete);

  const remainingProfiles = index.profiles.filter((p) => p.id !== idToDelete);
  const nextCurrentId = remainingProfiles.length > 0 ? remainingProfiles[0].id : null;

  setProfilesIndex({
    currentProfileId: nextCurrentId,
    profiles: remainingProfiles,
  });

  activeProfile = null;
}
