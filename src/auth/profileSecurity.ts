import { encryptJsonWithPassphrase, decryptJsonWithPassphrase, type EncryptedPayload } from "../crypto/cryptoService";

// NOTE:
// Profile data is encrypted with a key derived from the profile PIN.
// We only ever keep/compare the PIN hash in memory during a session.

const rawProfilePinSalt =
  (import.meta.env.VITE_PROFILE_PIN_SALT as string | undefined) ??
  (import.meta.env.TRAEKY_PROFILE_PIN_SALT as string | undefined);

const PROFILE_PIN_SALT = rawProfilePinSalt ?? "";


// NOTE:
// We intentionally do NOT use a global app encryption key.
// Profile data is encrypted with the respective profile PIN-derived key (pinHash).
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
  const salt = PROFILE_PIN_SALT;
  const data = encoder.encode(`${salt}:${pin}`);
  const digest = await getWebCrypto().subtle.digest("SHA-256", data);
  const hex = toHex(digest);
  return hex;
}

export async function encryptProfilePayload<T>(pinHash: string, payload: T): Promise<EncryptedPayload> {
  if (!pinHash) {
    throw new Error("Missing PIN hash");
  }
  return encryptJsonWithPassphrase(payload, pinHash);
}

export async function decryptProfilePayload<T>(pinHash: string, encrypted: EncryptedPayload): Promise<T> {
  if (!pinHash) {
    throw new Error("Missing PIN hash");
  }
  return decryptJsonWithPassphrase<T>(encrypted, pinHash);
}