/**
 * Client-side data mode selection for Traeky.
 *
 * This module is responsible for deciding how the app stores data locally.
 * The current build operates purely in local-only mode (no network access).
 * This keeps the app simple and privacy‑friendly.
 */
export type DataSourceMode = "local-only";

const STORAGE_KEY = "traeky:data-source-mode";

export function getPreferredMode(): DataSourceMode {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "local-only") {
      return "local-only";
    }
  } catch {
    // Ignore storage errors and fall back to local-only.
  }
  return "local-only";
}

export function setPreferredMode(_mode: DataSourceMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, "local-only");
  } catch {
    // Ignore persistence errors; mode will simply not be remembered.
  }
}
