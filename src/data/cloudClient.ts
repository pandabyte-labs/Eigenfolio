import type { EncryptedPayload } from "../crypto/cryptoService";

/**
 * Direction of a sync operation with the Traeky Cloud.
 *
 * - "push": upload the local encrypted snapshot to the cloud.
 * - "pull": download the latest encrypted snapshot from the cloud.
 */
export type CloudSyncDirection = "push" | "pull";

/**
 * Minimal client interface for talking to the Traeky Cloud backend.
 *
 * The backend is expected to store opaque, end-to-end encrypted blobs
 * only. It must never see plaintext portfolio data. This interface is
 * intentionally small to keep the cloud side easy to implement, hard to
 * misuse and simple to evolve.
 */
export interface CloudClient {
  /**
   * Upload the given encrypted snapshot to the Traeky Cloud.
   *
   * Implementations MUST:
   * - use TLS (HTTPS) for transport;
   * - treat the payload as opaque;
   * - associate it with the currently authenticated user/session.
   */
  uploadEncryptedSnapshot(payload: EncryptedPayload): Promise<void>;

  /**
   * Download the latest encrypted snapshot for the current user from the
   * Traeky Cloud, if any.
   *
   * Implementations MUST:
   * - return `null` if no snapshot exists yet;
   * - never attempt to inspect or decrypt the payload server-side.
   */
  downloadLatestEncryptedSnapshot(): Promise<EncryptedPayload | null>;
}

/**
 * Standalone frontend placeholder client.
 *
 * In the standalone setup, no backend is configured. This implementation
 * deliberately does not persist anything remotely, but keeps the call-
 * sites clear and ready for a future cloud-enabled build.
 */
class NoopCloudClient implements CloudClient {
  async uploadEncryptedSnapshot(_payload: EncryptedPayload): Promise<void> {
    console.warn(
      "[CloudClient] uploadEncryptedSnapshot called in standalone mode (no backend configured).",
    );
  }

  async downloadLatestEncryptedSnapshot(): Promise<EncryptedPayload | null> {
    console.warn(
      "[CloudClient] downloadLatestEncryptedSnapshot called in standalone mode (no backend configured).",
    );
    return null;
  }
}

/**
 * Factory used by the app for obtaining a cloud client instance.
 *
 * The standalone frontend returns a no-op implementation. A future
 * cloud-aware build can replace this with a real client that talks
 * to the Traeky Cloud backend via HTTPS.
 */
export function createCloudClient(): CloudClient {
  return new NoopCloudClient();
}
