import { encryptJsonWithPassphrase, decryptJsonWithPassphrase, type EncryptedPayload } from "../crypto/cryptoService";

/**
 * Security model
 * - Profile data encryption is strictly PIN-based (no fixed app key).
 * - The PIN is scoped to a single profile by binding the encryption passphrase to the profileId.
 * - PIN verification uses a hash index. Existing installs may still have legacy hashes.
 */

function getWebCrypto(): Crypto {
  if (typeof globalThis !== "undefined" && globalThis.crypto && "subtle" in globalThis.crypto) {
    return globalThis.crypto as Crypto;
  }
  throw new Error("Web Crypto API is not available in this environment");
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const digest = await getWebCrypto().subtle.digest("SHA-256", data);
  return toHex(digest);
}

// Legacy PIN hash (v1) kept for backwards compatibility.
// Previous builds optionally used an env-provided salt.
const rawProfilePinSalt =
  (import.meta.env.VITE_PROFILE_PIN_SALT as string | undefined) ??
  (import.meta.env.TRAEKY_PROFILE_PIN_SALT as string | undefined);

const PROFILE_PIN_SALT_LEGACY = rawProfilePinSalt ?? "";

export async function hashPinLegacy(pin: string): Promise<string> {
  return sha256Hex(`${PROFILE_PIN_SALT_LEGACY}:${pin}`);
}

// New PIN hash (v2) is profile-scoped.
export async function hashPinForProfile(profileId: string, pin: string): Promise<string> {
  return sha256Hex(`traeky:pin-hash:v2:${profileId}:${pin}`);
}

function deriveProfilePassphrase(profileId: string, pin: string): string {
  // Binds the encryption key to the profileId so the same PIN cannot decrypt another profile.
  // This also makes it harder to accidentally swap encrypted blobs between profiles.
  return `traeky:profile-encryption:v2:${profileId}:${pin}`;
}

export async function encryptProfilePayload<T>(
  profileId: string,
  pin: string,
  payload: T,
): Promise<EncryptedPayload> {
  return encryptJsonWithPassphrase(payload, deriveProfilePassphrase(profileId, pin));
}

export async function decryptProfilePayload<T>(
  profileId: string,
  pin: string,
  encrypted: EncryptedPayload,
): Promise<T> {
  return decryptJsonWithPassphrase<T>(encrypted, deriveProfilePassphrase(profileId, pin));
}

// ---- Legacy support (pre v26.1.24.0)
// Older installs encrypted profile payloads with a fixed passphrase set via env.
// We keep this as an optional compatibility path for one-time migration/re-keying.
const rawLegacyKey =
  (import.meta.env.VITE_PROFILE_ENCRYPTION_KEY as string | undefined) ??
  (import.meta.env.TRAEKY_PROFILE_ENCRYPTION_KEY as string | undefined);

const LEGACY_FIXED_PASSPHRASE: string | null = rawLegacyKey ?? null;

export function hasLegacyProfileEncryptionSupport(): boolean {
  return !!LEGACY_FIXED_PASSPHRASE;
}

export async function decryptProfilePayloadLegacy<T>(encrypted: EncryptedPayload): Promise<T> {
  if (!LEGACY_FIXED_PASSPHRASE) {
    throw new Error("Legacy profile decryption is not available (missing env key)");
  }
  return decryptJsonWithPassphrase<T>(encrypted, LEGACY_FIXED_PASSPHRASE);
}
