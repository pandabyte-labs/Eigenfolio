
import type { AppConfig, Transaction } from "../domain/types";
import { DEFAULT_HOLDING_PERIOD_DAYS, DEFAULT_UPCOMING_WINDOW_DAYS } from "../domain/config";
import type { EncryptedPayload } from "../crypto/cryptoService";
import {
  hashPinLegacy,
  hashPinForProfile,
  decryptProfilePayload,
  encryptProfilePayload,
  decryptProfilePayloadLegacy,
} from "./profileSecurity";
import { kvGet, kvSet, kvDel } from "../storage/kvDb";
import { readSyncFileIfNewer, scheduleAutoSync } from "../storage/traekyDbFile";

export type ProfileId = string;

export type ProfileSummary = {
  id: ProfileId;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type ProfileOverview = {
  profiles: ProfileSummary[];
  hasLegacyData: boolean;
};

type ProfileDataPayloadVersion = 1;

type ProfileDataPayload = {
  version: ProfileDataPayloadVersion;
  transactions: Transaction[];
  nextTransactionId: number;
  config: AppConfig;
};

type ProfilesIndex = {
  currentProfileId: ProfileId | null;
  profiles: ProfileSummary[];
};

type ActiveProfileSession = {
  meta: ProfileSummary;
  pinHash: string;
  data: ProfileDataPayload;
};

const LS_PROFILES_INDEX_KEY = "traeky:profiles:index";
const PROFILE_DATA_PREFIX = "traeky:profile:";
const PROFILE_DATA_SUFFIX = ":data";

const LEGACY_TRANSACTIONS_KEY = "traeky:transactions";
const LEGACY_NEXT_ID_KEY = "traeky:next-tx-id";
const LEGACY_CONFIG_KEY = "traeky:app-config";
const PROFILE_PIN_INDEX_KEY = "traeky:profiles-pin-index";

type ProfilePinIndexEntryV2 = { v: 2; hash: string };
type ProfilePinIndexEntryV1 = { v: 1; hash: string };
type ProfilePinIndexEntry = ProfilePinIndexEntryV1 | ProfilePinIndexEntryV2;

type ProfilePinIndex = {
  [profileId: string]: string | ProfilePinIndexEntry;
};

let didInit = false;
let cachedProfilesIndex: ProfilesIndex = { currentProfileId: null, profiles: [] };
let cachedPinIndex: ProfilePinIndex = {};

let activeProfile: (ActiveProfileSession & { pin: string; pinHashVersion: 1 | 2 }) | null = null;

function getStorage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignore and fall back to null.
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

function removeKey(key: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Ignore persistence errors.
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function generateProfileId(): ProfileId {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readProfilesIndex(): ProfilesIndex {
  return cachedProfilesIndex;
}

function writeProfilesIndex(index: ProfilesIndex): void {
  cachedProfilesIndex = index;
  void kvSet(LS_PROFILES_INDEX_KEY, index);
  scheduleAutoSync();
}

function readProfilePinIndex(): ProfilePinIndex {
  return cachedPinIndex;
}

function writeProfilePinIndex(index: ProfilePinIndex): void {
  cachedPinIndex = index;
  void kvSet(PROFILE_PIN_INDEX_KEY, index);
  scheduleAutoSync();
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

function createEmptyProfileData(): ProfileDataPayload {
  return {
    version: 1,
    transactions: [],
    nextTransactionId: 1,
    config: createDefaultConfig(),
  };
}

function readLegacyTransactions(): Transaction[] {
  const items = readJson<Transaction[]>(LEGACY_TRANSACTIONS_KEY);
  if (!items || !Array.isArray(items)) return [];
  return items;
}

function readLegacyNextId(): number | null {
  const storage = getStorage();
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
  const cfg = readJson<AppConfig>(LEGACY_CONFIG_KEY);
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
  const coingeckoApiKey =
    typeof cfg.coingecko_api_key === "string" ? cfg.coingecko_api_key : null;

  return {
    holding_period_days: holding,
    upcoming_holding_window_days: upcoming,
    base_currency: baseCurrency,
    price_fetch_enabled: priceFetchEnabled,
    coingecko_api_key: coingeckoApiKey,
  };
}

function removeLegacyStorage(): void {
  removeKey(LEGACY_TRANSACTIONS_KEY);
  removeKey(LEGACY_NEXT_ID_KEY);
  removeKey(LEGACY_CONFIG_KEY);
}

function profileHasLegacyData(): boolean {
  const storage = getStorage();
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

function validateProfilesIndex(value: unknown): ProfilesIndex {
  const idx = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const profilesRaw = idx ? idx["profiles"] : null;
  if (!idx || !Array.isArray(profilesRaw)) {
    return { currentProfileId: null, profiles: [] };
  }

  const currentProfileId = typeof idx["currentProfileId"] === "string" ? idx["currentProfileId"] : null;
  const profiles: ProfileSummary[] = profilesRaw
    .map((p) => {
      const rec = typeof p === "object" && p !== null ? (p as Record<string, unknown>) : null;
      if (!rec) return null;
      const id = typeof rec["id"] === "string" ? rec["id"] : null;
      const name = typeof rec["name"] === "string" ? rec["name"] : "";
      const createdAt = typeof rec["createdAt"] === "string" ? rec["createdAt"] : nowIso();
      const updatedAt = typeof rec["updatedAt"] === "string" ? rec["updatedAt"] : createdAt;
      if (!id) return null;
      return { id, name, createdAt, updatedAt };
    })
    .filter((p): p is ProfileSummary => p !== null);

  return { currentProfileId, profiles };
}

function validatePinIndex(value: unknown): ProfilePinIndex {
  const idx = value as ProfilePinIndex | null;
  if (!idx || typeof idx !== "object") {
    return {};
  }
  return idx;
}

function hasLegacyProfileStorage(): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    if (storage.getItem(LS_PROFILES_INDEX_KEY) || storage.getItem(PROFILE_PIN_INDEX_KEY)) {
      return true;
    }
    // Best-effort: if any profile payloads exist, migration is needed.
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && key.startsWith(PROFILE_DATA_PREFIX) && key.endsWith(PROFILE_DATA_SUFFIX)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function migrateLegacyProfilesToDb(): Promise<void> {
  const legacyIndex = readJson<ProfilesIndex>(LS_PROFILES_INDEX_KEY);
  const legacyPinIndex = readJson<ProfilePinIndex>(PROFILE_PIN_INDEX_KEY);

  const safeIndex = validateProfilesIndex(legacyIndex);
  const safePinIndex = validatePinIndex(legacyPinIndex);

  await kvSet(LS_PROFILES_INDEX_KEY, safeIndex);
  await kvSet(PROFILE_PIN_INDEX_KEY, safePinIndex);

  for (const p of safeIndex.profiles) {
    const key = buildProfileDataKey(p.id);
    const encrypted = readJson<EncryptedPayload>(key);
    if (encrypted) {
      await kvSet(key, encrypted);
    }
  }

  // Clean up migrated keys to minimize risk of divergence.
  removeKey(LS_PROFILES_INDEX_KEY);
  removeKey(PROFILE_PIN_INDEX_KEY);
  for (const p of safeIndex.profiles) {
    removeKey(buildProfileDataKey(p.id));
  }
}

export async function initProfileStore(): Promise<void> {
  if (didInit) return;

  // If the user configured a sync file, import it when it is newer than local.
  await readSyncFileIfNewer();

  const idxFromDb = await kvGet<ProfilesIndex>(LS_PROFILES_INDEX_KEY);
  if (!idxFromDb && hasLegacyProfileStorage()) {
    await migrateLegacyProfilesToDb();
  }

  const idx = validateProfilesIndex(await kvGet(LS_PROFILES_INDEX_KEY));
  const pinIdx = validatePinIndex(await kvGet(PROFILE_PIN_INDEX_KEY));

  cachedProfilesIndex = idx;
  cachedPinIndex = pinIdx;
  didInit = true;
}

export function getProfileOverview(): ProfileOverview {
  const index = readProfilesIndex();
  return {
    profiles: index.profiles,
    hasLegacyData: profileHasLegacyData(),
  };
}

export function getActiveProfileSummary(): ProfileSummary | null {
  if (!activeProfile) return null;
  return activeProfile.meta;
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
  const encrypted: EncryptedPayload = await encryptProfilePayload(
    activeProfile.meta.id,
    activeProfile.pin,
    payload,
  );
  const key = buildProfileDataKey(activeProfile.meta.id);
  await kvSet(key, encrypted);
  scheduleAutoSync();
  const index = readProfilesIndex();
  const now = nowIso();
  const updatedProfiles = index.profiles.map((p) =>
    p.id === activeProfile!.meta.id ? { ...p, updatedAt: now, name: activeProfile!.meta.name } : p,
  );
  writeProfilesIndex({
    currentProfileId: activeProfile.meta.id,
    profiles: updatedProfiles,
  });
}

export async function createInitialProfile(name: string, pin: string): Promise<ProfileSummary> {
  const trimmedName = name.trim() || "Default";
  const index = readProfilesIndex();
  const id = generateProfileId();
  const pinHash = await hashPinForProfile(id, pin);
  const now = nowIso();
  const meta: ProfileSummary = {
    id,
    name: trimmedName,
    createdAt: now,
    updatedAt: now,
  };

  let data: ProfileDataPayload;

  if (profileHasLegacyData()) {
    const transactions = readLegacyTransactions();
    const nextId =
      readLegacyNextId() ??
      (transactions.length
        ? transactions.reduce((acc, tx) => (tx.id && tx.id > acc ? tx.id : acc), 0) + 1
        : 1);
    const config = readLegacyConfig() ?? createDefaultConfig();
    data = {
      version: 1,
      transactions,
      nextTransactionId: nextId,
      config,
    };
    removeLegacyStorage();
  } else {
    data = createEmptyProfileData();
  }

  activeProfile = {
    meta,
    pinHash,
    pinHashVersion: 2,
    pin,
    data,
  };

  const profiles = [...index.profiles, meta];
  writeProfilesIndex({
    currentProfileId: id,
    profiles,
  });

  const pinIndex = readProfilePinIndex();
  pinIndex[id] = { v: 2, hash: pinHash };
  writeProfilePinIndex(pinIndex);

  await persistActiveProfile();

  return meta;
}

export async function loginProfile(profileId: ProfileId, pin: string): Promise<ProfileSummary> {
  const index = readProfilesIndex();
  if (index.profiles.length === 0) {
    throw new Error("Profile not found");
  }

  const pinIndex = readProfilePinIndex();
  const meta = index.profiles.find((p) => p.id === profileId) ?? null;
  if (!meta) {
    throw new Error("Profile not found");
  }

  const stored = pinIndex[meta.id];
  if (!stored) {
    throw new Error("Invalid PIN");
  }

  const storedEntry: ProfilePinIndexEntry =
    typeof stored === "string" ? { v: 1, hash: stored } : stored;

  let pinHashVersion: 1 | 2 = storedEntry.v;
  let pinHash: string;
  if (storedEntry.v === 2) {
    pinHash = await hashPinForProfile(meta.id, pin);
  } else {
    pinHash = await hashPinLegacy(pin);
  }

  if (pinHash !== storedEntry.hash) {
    throw new Error("Invalid PIN");
  }

  // Upgrade legacy PIN hashes to profile-scoped v2 hashes once we have a valid PIN.
  if (storedEntry.v === 1) {
    const upgraded = await hashPinForProfile(meta.id, pin);
    pinIndex[meta.id] = { v: 2, hash: upgraded };
    writeProfilePinIndex(pinIndex);
    pinHashVersion = 2;
    pinHash = upgraded;
  }

  const key = buildProfileDataKey(meta.id);
  const encrypted = await kvGet<EncryptedPayload>(key);
  if (!encrypted) {
    throw new Error("Profile data not found");
  }

  let data: ProfileDataPayload;
  try {
    data = await decryptProfilePayload<ProfileDataPayload>(meta.id, pin, encrypted);
  } catch {
    // Backwards compatibility: old installs encrypted with a fixed env key.
    data = await decryptProfilePayloadLegacy<ProfileDataPayload>(encrypted);
    // Immediately re-encrypt with PIN-based encryption.
    const upgradedEncrypted = await encryptProfilePayload(meta.id, pin, data);
    await kvSet(key, upgradedEncrypted);
    scheduleAutoSync();
  }
  if (!data || data.version !== 1) {
    throw new Error("Unsupported profile data version");
  }

  activeProfile = {
    meta,
    pinHash,
    pinHashVersion,
    pin,
    data,
  };

  const now = nowIso();
  const updatedMeta: ProfileSummary = { ...meta, updatedAt: now };
  const updatedProfiles = index.profiles.map((p) => (p.id === meta!.id ? updatedMeta : p));
  writeProfilesIndex({
    currentProfileId: meta.id,
    profiles: updatedProfiles,
  });
  activeProfile.meta = updatedMeta;

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


export async function createAdditionalProfile(
  name: string,
  pin: string,
): Promise<ProfileSummary> {
  const trimmedName = name.trim() || "Profile";
  const index = readProfilesIndex();
  const id = generateProfileId();
  const pinHash = await hashPinForProfile(id, pin);
  const now = nowIso();

  const meta: ProfileSummary = {
    id,
    name: trimmedName,
    createdAt: now,
    updatedAt: now,
  };

  const data = createEmptyProfileData();
  const payload: ProfileDataPayload = data;
  const encrypted: EncryptedPayload = await encryptProfilePayload(id, pin, payload);
  const key = buildProfileDataKey(id);
  await kvSet(key, encrypted);
  scheduleAutoSync();

  const profiles = [...index.profiles, meta];

  writeProfilesIndex({
    currentProfileId: id,
    profiles,
  });

  const pinIndex = readProfilePinIndex();
  pinIndex[id] = { v: 2, hash: pinHash };
  writeProfilePinIndex(pinIndex);

  activeProfile = { meta, pinHash, pinHashVersion: 2, pin, data };

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
  const candidateHash =
    activeProfile.pinHashVersion === 1
      ? await hashPinLegacy(pin)
      : await hashPinForProfile(activeProfile.meta.id, pin);
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

export async function changeActiveProfilePin(
  currentPin: string,
  newPin: string,
): Promise<void> {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  const currentHash =
    activeProfile.pinHashVersion === 1
      ? await hashPinLegacy(currentPin)
      : await hashPinForProfile(activeProfile.meta.id, currentPin);
  if (currentHash !== activeProfile.pinHash) {
    throw new Error("Invalid current PIN");
  }
  const newHash = await hashPinForProfile(activeProfile.meta.id, newPin);
  activeProfile.pin = newPin;
  activeProfile.pinHashVersion = 2;
  activeProfile.pinHash = newHash;

  const pinIndex = readProfilePinIndex();
  pinIndex[activeProfile.meta.id] = { v: 2, hash: newHash };
  writeProfilePinIndex(pinIndex);

  void persistActiveProfile();
}

export function deleteActiveProfile(): void {
  if (!activeProfile) {
    throw new Error("No active profile session");
  }
  const index = readProfilesIndex();
  const idToDelete = activeProfile.meta.id;

  const key = buildProfileDataKey(idToDelete);
  void kvDel(key);
  scheduleAutoSync();

  const pinIndex = readProfilePinIndex();
  delete pinIndex[idToDelete];
  writeProfilePinIndex(pinIndex);

  const remainingProfiles = index.profiles.filter((p) => p.id !== idToDelete);
  const nextCurrentId = remainingProfiles.length > 0 ? remainingProfiles[0].id : null;

  writeProfilesIndex({
    currentProfileId: nextCurrentId,
    profiles: remainingProfiles,
  });

  activeProfile = null;
}