/**
 * Client-side cryptography helpers for Traeky.
 *
 * This module provides a small wrapper around the Web Crypto API so that
 * sensitive portfolio data can be encrypted locally before being sent to any
 * cloud service.
 *
 * IMPORTANT:
 * - This is a frontend-only utility. Keys MUST NOT be sent to the cloud.
 * - Key management (rotation, backup, recovery) will be defined in a later
 *   step together with the backend protocol.
 */

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256; // bits
const IV_LENGTH_BYTES = 12; // recommended for GCM

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Generate a new symmetric key for encrypting portfolio data.
 *
 * NOTE:
 * - The caller is responsible for persisting this key securely (e.g. wrapped
 *   with a passkey-protected secret or derived from a user credential).
 */
export async function generateEncryptionKey(): Promise<CryptoKey> {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error("Web Crypto API is not available in this environment.");
  }

  return window.crypto.subtle.generateKey(
    {
      name: ALGORITHM,
      length: KEY_LENGTH,
    },
    true,
    ["encrypt", "decrypt"],
  );
}

/**
 * Export a CryptoKey to a base64-encoded raw key.
 */
export async function exportEncryptionKey(key: CryptoKey): Promise<string> {
  const raw = await window.crypto.subtle.exportKey("raw", key);
  return arrayBufferToBase64(raw);
}

/**
 * Import a CryptoKey from a base64-encoded raw key.
 */
export async function importEncryptionKey(serialized: string): Promise<CryptoKey> {
  const raw = base64ToArrayBuffer(serialized);
  return window.crypto.subtle.importKey(
    "raw",
    raw,
    { name: ALGORITHM },
    true,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a JSON-serializable value using AES-GCM.
 *
 * Returns a base64 string containing IV + ciphertext.
 */
export async function encryptJson(value: JsonValue, key: CryptoKey): Promise<string> {
  const iv = window.crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const encoded = new TextEncoder().encode(JSON.stringify(value));

  const ciphertext = await window.crypto.subtle.encrypt(
    {
      name: ALGORITHM,
      iv,
    },
    key,
    encoded,
  );

  // Concatenate IV + ciphertext into a single buffer for transport/storage.
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.byteLength);

  return arrayBufferToBase64(combined.buffer);
}

/**
 * Decrypt a base64-encoded IV + ciphertext pair back into a JSON value.
 */
export async function decryptJson<T extends JsonValue>(
  payload: string,
  key: CryptoKey,
): Promise<T> {
  const combined = new Uint8Array(base64ToArrayBuffer(payload));
  if (combined.byteLength <= IV_LENGTH_BYTES) {
    throw new Error("Encrypted payload is too short.");
  }

  const iv = combined.slice(0, IV_LENGTH_BYTES);
  const ciphertext = combined.slice(IV_LENGTH_BYTES);

  const plaintext = await window.crypto.subtle.decrypt(
    {
      name: ALGORITHM,
      iv,
    },
    key,
    ciphertext,
  );

  const decoded = new TextDecoder().decode(plaintext);
  return JSON.parse(decoded) as T;
}

/**
 * Convert an ArrayBuffer to a base64 string using browser-safe APIs.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

/**
 * Convert a base64 string back into an ArrayBuffer.
 */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = window.atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
