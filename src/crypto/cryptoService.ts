/**
 * Frontend-only encryption helpers for preparing zero-knowledge cloud sync.
 *
 * IMPORTANT:
 * - This module is intentionally self-contained and does not talk to any
 *   backend. It only provides primitives for encrypting/decrypting JSON
 *   payloads in the browser.
 * - A full security review is required before using this in production.
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

const PBKDF2_ITERATIONS = 200_000;
const PBKDF2_HASH = "SHA-256";
const AES_ALGO = "AES-GCM";
const AES_KEY_LENGTH = 256;

function getCrypto(): Crypto {
  if (typeof window !== "undefined" && window.crypto) {
    return window.crypto;
  }
  throw new Error("Web Crypto API is not available in this environment.");
}

function encodeUtf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function toBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  throw new Error("btoa is not available in this environment.");
}

function fromBase64(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  throw new Error("atob is not available in this environment.");
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const crypto = getCrypto();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encodeUtf8(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    baseKey,
    {
      name: AES_ALGO,
      length: AES_KEY_LENGTH,
    },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt arbitrary JSON-serializable data with a passphrase.
 *
 * NOTE:
 * - This is a convenience wrapper for prototyping the zero-knowledge design.
 * - Later, we might separate long-term key management from passphrases and
 *   derive keys from passkeys or dedicated key material.
 */
export async function encryptJsonWithPassphrase(
  data: unknown,
  passphrase: string,
): Promise<EncryptedPayload> {
  const crypto = getCrypto();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);

  const plaintext = encodeUtf8(JSON.stringify(data));
  const ciphertextBuf = await crypto.subtle.encrypt(
    {
      name: AES_ALGO,
      iv,
    },
    key,
    plaintext,
  );

  const ciphertext = new Uint8Array(ciphertextBuf);

  return {
    version: 1,
    algorithm: "AES-GCM",
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
  };
}

/**
 * Decrypt an EncryptedPayload with the given passphrase and parse the JSON.
 */
export async function decryptJsonWithPassphrase<T = unknown>(
  payload: EncryptedPayload,
  passphrase: string,
): Promise<T> {
  if (payload.algorithm !== "AES-GCM") {
    throw new Error(`Unsupported algorithm: ${payload.algorithm}`);
  }

  const crypto = getCrypto();
  const salt = fromBase64(payload.salt);
  const iv = fromBase64(payload.iv);
  const ciphertext = fromBase64(payload.ciphertext);

  const key = await deriveKey(passphrase, salt);

  const plaintextBuf = await crypto.subtle.decrypt(
    {
      name: AES_ALGO,
      iv,
    },
    key,
    ciphertext,
  );

  const json = decodeUtf8(new Uint8Array(plaintextBuf));
  return JSON.parse(json) as T;
}
