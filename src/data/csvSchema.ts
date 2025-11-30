export const CURRENT_CSV_SCHEMA_VERSION = 3;
export const CSV_SCHEMA_VERSION_COLUMN = "csv_schema_version";

export function parseCsvSchemaVersion(value: string | undefined | null): number {
  if (!value) return 1;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 1;
  }
  return parsed;
}