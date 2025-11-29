/**
 * Client-side data mode selection for Traeky.
 *
 * This module is responsible for deciding whether the app should operate in
 * local-only mode (no cloud) or use the Traeky Cloud service. The default is now local-only mode to emphasize privacy
 * and standalone usage; cloud sync can be enabled via login.
 */
export type DataSourceMode = "cloud" | "local-only";

const STORAGE_KEY = "traeky:data-source-mode";

export function getPreferredMode(): DataSourceMode {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "cloud" || raw === "local-only") {
      return raw as DataSourceMode;
    }
    // Backwards compatibility: treat legacy "backend" as "cloud"
    if (raw === "backend") {
      return "cloud";
    }
  } catch {
    // Access to localStorage might fail in some environments; ignore and fallback.
  }
  // Default to local-only mode to keep all data on the client unless the user
  // explicitly opts into using the cloud service.
  return "local-only";
}

export function setPreferredMode(mode: DataSourceMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Ignore persistence errors; mode will simply not be remembered.
  }
}
