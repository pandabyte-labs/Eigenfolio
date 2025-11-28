import { encryptJsonWithPassphrase, decryptJsonWithPassphrase, type EncryptedPayload } from "../crypto/cryptoService";

// NOTE:
// - The profile PIN is used only for authentication (verifying the user-entered PIN).
// - The actual profile data is encrypted with a fixed application key, not the PIN hash.
//   This avoids subtle issues where changing the PIN or salt would make old data unreadable.
// - The PIN hash is stored separately in localStorage and compared during login.

const FIXED_PROFILE_PIN_SALT = "traeky-profile-pin-default-salt";
const FIXED_PROFILE_ENCRYPTION_KEY = "traeky-profile-encryption-key-v1";

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
    const part = bytes[i].toString(16).padStart(2, "0");
    hex += part;
  }
  return hex;
}

export async function hashPin(pin: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = FIXED_PROFILE_PIN_SALT;
  const data = encoder.encode(`${salt}:${pin}`);
  const digest = await getWebCrypto().subtle.digest("SHA-256", data);
  const hex = toHex(digest);
  return hex;
}

export async function encryptProfilePayload<T>(pinHash: string, payload: T): Promise<EncryptedPayload> {
  // NOTE: pinHash is intentionally ignored here. We always use a fixed encryption key.
  return encryptJsonWithPassphrase(payload, FIXED_PROFILE_ENCRYPTION_KEY);
}

export async function decryptProfilePayload<T>(pinHash: string, encrypted: EncryptedPayload): Promise<T> {
  // NOTE: pinHash is intentionally ignored here. We always use a fixed encryption key.
  return decryptJsonWithPassphrase<T>(encrypted, FIXED_PROFILE_ENCRYPTION_KEY);
}
