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
