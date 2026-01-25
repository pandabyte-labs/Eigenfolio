/**
 * Client-side data mode selection for Traeky.
 *
 * This module is responsible for deciding how the app stores data locally.
 * The current build operates purely in local-only mode (no network access).
 * This keeps the app simple and privacy‑friendly.
 */
export type DataSourceMode = "local-only";

// NOTE: This build operates purely in local-only mode.
// Persistence is handled via the Traeky DB file (manual sync),
// so we do not store any mode selection in localStorage.

export function getPreferredMode(): DataSourceMode {
  return "local-only";
}

export function setPreferredMode(_mode: DataSourceMode): void {
  // Intentionally no-op.
}
