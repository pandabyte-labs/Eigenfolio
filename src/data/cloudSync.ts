import type { AppConfig, Transaction } from "../domain/types";
import type { EncryptedPayload } from "../crypto/cryptoService";
import { encryptJsonWithPassphrase, decryptJsonWithPassphrase } from "../crypto/cryptoService";

/**
 * Domain-level representation of what should be stored in the Traeky Cloud.
 *
 * NOTE:
 * - Holdings and expiring-holding data can always be recomputed from
 *   transactions + config, so we only persist the minimal input set here.
 * - This type is intentionally simple to keep encryption and validation
 *   boundaries clear.
 */

export type AssetPriceSnapshot = {
  eur?: number | null;
  usd?: number | null;
  fetched_at?: number | null;
};

export type AssetPriceMap = Record<string, AssetPriceSnapshot>;

export type PortfolioSnapshot = {
  config: AppConfig;
  transactions: Transaction[];
  /**
   * Optional per-asset price information that was already fetched by the
   * frontend. This allows the application to restore/sync portfolios without
   * having to re-query external price APIs for historical token prices.
   *
   * Keys are uppercased asset symbols (e.g. "BTC", "ETH").
   */
  assetPrices?: AssetPriceMap;
};

/**
 * Helper to build a `PortfolioSnapshot` from the current in-memory state.
 *
 * This is a pure function; it does not perform any IO.
 */
export function createPortfolioSnapshot(
  config: AppConfig,
  transactions: Transaction[],
  assetPrices?: AssetPriceMap,
): PortfolioSnapshot {
  return {
    config,
    transactions,
    assetPrices,
  };
}

/**
 * Encrypt a portfolio snapshot for cloud storage using the frontend crypto service.
 *
 * This function is intended to be called just before sending data to the
 * Traeky Cloud. It ensures that the backend only ever sees encrypted
 * blobs and never plaintext user data.
 */
export async function encryptSnapshotForCloud(
  snapshot: PortfolioSnapshot,
  passphrase: string,
): Promise<EncryptedPayload> {
  return encryptJsonWithPassphrase(snapshot, passphrase);
}

/**
 * Decrypt a portfolio snapshot that was previously encrypted for cloud storage.
 *
 * This function will be used when restoring/syncing state from the Traeky
 * Cloud. It expects the same passphrase (or key material) that was used to
 * encrypt the snapshot.
 */
export async function decryptSnapshotFromCloud(
  payload: EncryptedPayload,
  passphrase: string,
): Promise<PortfolioSnapshot> {
  const snapshot = await decryptJsonWithPassphrase<PortfolioSnapshot>(payload, passphrase);
  return snapshot;
}
