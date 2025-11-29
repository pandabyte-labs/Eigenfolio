import type { Transaction, HoldingsResponse, ExpiringHolding } from "../domain/types";
import type { JsonValue } from "./cryptoClient";

/**
 * Shape of the data snapshot that will be encrypted client-side before being
 * sent to the Traeky Cloud.
 *
 * This is intentionally simple and self-contained so it can be versioned and
 * validated independently on the backend without needing to know any secrets.
 */
export interface EncryptedCloudSnapshotMeta {
  version: number;
  created_at: string; // ISO timestamp generated on the client
}

export interface CloudSnapshotPlain {
  meta: EncryptedCloudSnapshotMeta;
  transactions: Transaction[];
  holdings: HoldingsResponse;
  expiring: ExpiringHolding[];
}

/**
 * Minimal wrapper type for an encrypted snapshot payload.
 * The actual ciphertext format is defined in `cryptoClient.encryptJson`.
 */
export interface EncryptedCloudSnapshot {
  meta: EncryptedCloudSnapshotMeta;
  ciphertext: string; // base64-encoded IV + ciphertext
}

/**
 * Convert the current in-memory portfolio state into a plain snapshot object
 * that can then be encrypted with `encryptJson`.
 */
export function buildPlainSnapshot(
  args: {
    transactions: Transaction[];
    holdings: HoldingsResponse;
    expiring: ExpiringHolding[];
  },
): CloudSnapshotPlain {
  const nowIso = new Date().toISOString();
  return {
    meta: {
      version: 1,
      created_at: nowIso,
    },
    transactions: args.transactions,
    holdings: args.holdings,
    expiring: args.expiring,
  };
}

/**
 * Convert a decrypted JSON value into a strongly typed CloudSnapshotPlain.
 * This is a thin validation layer; deeper schema validation will be added on
 * the backend side to protect the shared cloud database.
 */
export function jsonToPlainSnapshot(value: JsonValue): CloudSnapshotPlain {
  if (typeof value !== "object" || value === null) {
    throw new Error("Decrypted snapshot is not an object.");
  }

  const anyVal = value as any;
  if (!anyVal.meta || !anyVal.transactions || !anyVal.holdings || !anyVal.expiring) {
    throw new Error("Decrypted snapshot is missing required fields.");
  }

  return anyVal as CloudSnapshotPlain;
}
