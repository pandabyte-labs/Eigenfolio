/**
 * Encrypted payload format used for local profile storage.
 *
 * NOTE:
 * - This module intentionally only defines the shape of the encrypted payload.
 * - The actual encryption/decryption logic for profile data lives in
 *   auth/profileSecurity.ts and related modules.
 * - There is no cloud/online/sync functionality in this build.
 */
export type SupportedEncryptionVersion = 1;

export interface EncryptedPayload {
  version: SupportedEncryptionVersion;
  algorithm: "AES-GCM";
  /** Base64-encoded salt used for key derivation (PBKDF2). */
  salt: string;
  /** Base64-encoded initialization vector for AES-GCM. */
  iv: string;
  /** Base64-encoded ciphertext of the JSON payload. */
  ciphertext: string;
}


const AES_ALGO = "AES-GCM";
const AES_KEY_LENGTH = 256;
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_HASH = "SHA-256";
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

function getWebCrypto(): Crypto {
  if (typeof globalThis !== "undefined" && globalThis.crypto && "subtle" in globalThis.crypto) {
    return globalThis.crypto as Crypto;
  }
  throw new Error("Web Crypto API is not available in this environment");
}

function encodeUtf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "undefined") {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  // Fallback for non-browser environments – this module is primarily used in the browser.
  throw new Error("Base64 encoding is not supported in this environment");
}

function base64ToBytes(base64: string): Uint8Array {
  if (!base64) {
    return new Uint8Array();
  }
  if (typeof atob !== "undefined") {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  // Fallback for non-browser environments – this module is primarily used in the browser.
  throw new Error("Base64 decoding is not supported in this environment");
}

function randomBytes(length: number): Uint8Array {
  const crypto = getWebCrypto();
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const crypto = getWebCrypto();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encodeUtf8(passphrase) as unknown as BufferSource,
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    keyMaterial,
    {
      name: AES_ALGO,
      length: AES_KEY_LENGTH,
    },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptJsonWithPassphrase<T>(payload: T, passphrase: string): Promise<EncryptedPayload> {
  const crypto = getWebCrypto();
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = await deriveKey(passphrase, salt);

  const plaintext = encodeUtf8(JSON.stringify(payload));
  const ciphertextBuf = await crypto.subtle.encrypt(
    {
      name: AES_ALGO,
      iv: iv as unknown as BufferSource,
    },
    key,
    plaintext as unknown as BufferSource,
  );

  const ciphertext = new Uint8Array(ciphertextBuf);

  return {
    version: 1,
    algorithm: AES_ALGO,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  };
}

export async function decryptJsonWithPassphrase<T>(encrypted: EncryptedPayload, passphrase: string): Promise<T> {
  const crypto = getWebCrypto();
  if (encrypted.algorithm !== AES_ALGO || encrypted.version !== 1) {
    throw new Error("Unsupported encryption format");
  }

  const salt = base64ToBytes(encrypted.salt);
  const iv = base64ToBytes(encrypted.iv);
  const ciphertext = base64ToBytes(encrypted.ciphertext);

  const key = await deriveKey(passphrase, salt);
  const plaintextBuf = await crypto.subtle.decrypt(
    {
      name: AES_ALGO,
      iv: iv as unknown as BufferSource,
    },
    key,
    ciphertext as unknown as BufferSource,
  );

  const decoder = new TextDecoder();
  const json = decoder.decode(plaintextBuf);
  return JSON.parse(json) as T;
}