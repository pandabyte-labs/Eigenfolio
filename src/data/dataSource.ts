import jsPDF from "jspdf";
import { API_BASE_URL, CONFIG_URL, fetchJson } from "./backendApi";
import { applyPricesToHoldings } from "./priceService";
import type {
  AppConfig,
  HoldingsResponse,
  Transaction,
  ExpiringHolding,
  CsvImportResult,
} from "../domain/types";
import type { Language } from "../i18n";
import type { DataSourceMode } from "./localStore";
import { DEFAULT_HOLDING_PERIOD_DAYS, DEFAULT_UPCOMING_WINDOW_DAYS } from "../domain/config";
import { CURRENT_CSV_SCHEMA_VERSION, CSV_SCHEMA_VERSION_COLUMN } from "./csvSchema";
import { t } from "../i18n";

/**
 * Abstraction layer for portfolio data access.
 *
 * This allows us to:
 * - use a backend-based implementation (Eigenfolio backend / cloud),
 * - and a purely local implementation (local-only mode),
 *   without changing the UI components.
 */
export interface PortfolioDataSource {
  loadInitialData(): Promise<{
    config: AppConfig;
    holdings: HoldingsResponse;
    transactions: Transaction[];
    expiring: ExpiringHolding[];
  }>;

  saveTransaction(payload: {
    id?: number | null;
    asset_symbol: string;
    tx_type: string;
    amount: number;
    price_fiat: number | null;
    fiat_currency: string;
    timestamp: string;
    source: string | null;
    note: string | null;
    tx_id: string | null;
  }): Promise<void>;

  deleteTransaction(id: number): Promise<void>;

  importCsv(lang: Language, file: File): Promise<CsvImportResult>;

  exportPdf(lang: Language, transactions?: Transaction[]): Promise<Blob>;
}

/**
 * Cloud-based implementation using the existing Eigenfolio API.
 */
class CloudDataSource implements PortfolioDataSource {
  async loadInitialData() {
    const [configJson, holdingsJson, txJson, expiringJson] = await Promise.all([
      fetchJson<AppConfig>(CONFIG_URL),
      fetchJson<HoldingsResponse>(`${API_BASE_URL}holdings`),
      fetchJson<Transaction[]>(`${API_BASE_URL}?limit=50`),
      fetchJson<ExpiringHolding[]>(`${API_BASE_URL}expiring`),
    ]);

    return {
      config: configJson,
      holdings: holdingsJson,
      transactions: txJson,
      expiring: expiringJson,
    };
  }

  async saveTransaction(payload: {
    id?: number | null;
    asset_symbol: string;
    tx_type: string;
    amount: number;
    price_fiat: number | null;
    fiat_currency: string;
    timestamp: string;
    source: string | null;
    note: string | null;
    tx_id: string | null;
  }): Promise<void> {
    const isEdit = payload.id != null;
    const url = isEdit ? `${API_BASE_URL}${payload.id}` : `${API_BASE_URL}`;
    const method = isEdit ? "PUT" : "POST";

    // Build backend payload without id field; backend determines id itself.
    const { id, ...rest } = payload;

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rest),
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error("Cloud save error:", res.status, txt);
      throw new Error("Error while saving transaction");
    }
  }

  async deleteTransaction(id: number): Promise<void> {
    const res = await fetch(`${API_BASE_URL}${id}`, { method: "DELETE" });
    if (!res.ok) {
      const txt = await res.text();
      console.error("Cloud delete error:", res.status, txt);
      throw new Error("Error while deleting transaction");
    }
  }

  async importCsv(lang: Language, file: File): Promise<CsvImportResult> {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) {
      return { imported: 0, errors: ["CSV has no data rows."] };
    }

    const delimiter = lines[0].includes(";") && !lines[0].includes(",") ? ";" : ",";
    const headerCols = lines[0].split(delimiter).map((c) => c.trim());
    const required = ["asset_symbol", "tx_type", "amount", "timestamp"];

    const missing = required.filter((r) => !headerCols.includes(r));
    if (missing.length > 0) {
      return {
        imported: 0,
        errors: [`Missing required columns: ${missing.join(", ")}`],
      };
    }

    const items = loadLocalTransactions();
    const existingKeys = new Set<string>(items.map((tx) => buildTransactionDedupKey(tx)));
    const importedKeys = new Set<string>();
    const errors: string[] = [];
    let importedCount = 0;

    const versionColIndex = headerCols.indexOf(CSV_SCHEMA_VERSION_COLUMN);
    let csvVersion = 1;
    if (versionColIndex >= 0 && lines.length > 1) {
      const firstDataParts = lines[1].split(delimiter);
      const rawVersion = (firstDataParts[versionColIndex] || "").trim();
      const parsedVersion = parseInt(rawVersion, 10);
      if (Number.isFinite(parsedVersion) && parsedVersion > 0) {
        csvVersion = parsedVersion;
      }
    }
    if (csvVersion > CURRENT_CSV_SCHEMA_VERSION) {
      errors.push(
        t(lang, "csv_import_schema_newer_warning"),
      );
    }

    for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
      const row = lines[lineIndex];
      if (!row.trim()) {
        continue;
      }

      const parts = row.split(delimiter);
      if (parts.length !== headerCols.length) {
        errors.push(`${t(lang, "csv_import_error_line_prefix")} ${lineIndex + 1}: ${t(lang, "csv_import_error_column_mismatch")}`);
        continue;
      }

      const record: Record<string, string> = {};
      headerCols.forEach((col, idx) => {
        let value = parts[idx] ?? "";
        value = value.trim();
        if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
          value = value.slice(1, -1);
        }
        record[col] = value;
      });

      try {
        let rawAmount = record["amount"];
        if (!rawAmount) {
          throw new Error("csv_invalid_amount");
        }
        rawAmount = rawAmount.trim().replace(/\s+/g, "");

        if (rawAmount.includes(",") && rawAmount.includes(".")) {
          const lastComma = rawAmount.lastIndexOf(",");
          const lastDot = rawAmount.lastIndexOf(".");
          if (lastComma > lastDot) {
            rawAmount = rawAmount.replace(/\./g, "").replace(",", ".");
          } else {
            rawAmount = rawAmount.replace(/,/g, "");
          }
        } else if (rawAmount.includes(",")) {
          rawAmount = rawAmount.replace(",", ".");
        }

        const amount = parseFloat(rawAmount);
        if (!Number.isFinite(amount)) {
          throw new Error("csv_invalid_amount");
        }

        const id = getNextLocalId();

        let priceFiat: number | null = null;
        if (record["price_fiat"]) {
          let rawPrice = record["price_fiat"].trim().replace(/\s+/g, "");
          if (rawPrice.includes(",") && rawPrice.includes(".")) {
            const lastComma = rawPrice.lastIndexOf(",");
            const lastDot = rawPrice.lastIndexOf(".");
            if (lastComma > lastDot) {
              rawPrice = rawPrice.replace(/\./g, "").replace(",", ".");
            } else {
              rawPrice = rawPrice.replace(/,/g, "");
            }
          } else if (rawPrice.includes(",")) {
            rawPrice = rawPrice.replace(",", ".");
          }
          const parsedPrice = parseFloat(rawPrice);
          priceFiat = Number.isFinite(parsedPrice) ? parsedPrice : null;
        }

        const fiatValue =
          priceFiat != null && Number.isFinite(priceFiat) ? priceFiat * amount : null;

        const tx: Transaction = {
          id,
          asset_symbol: (record["asset_symbol"] || "").toUpperCase(),
          tx_type: (record["tx_type"] || "").toUpperCase(),
          amount,
          price_fiat: priceFiat,
          fiat_currency: record["fiat_currency"] || "EUR",
          timestamp: record["timestamp"],
          source: record["source"] || null,
          note: record["note"] || null,
          tx_id: record["tx_id"] || null,
          fiat_value: fiatValue,
          value_eur: null,
          value_usd: null,
        };

        const key = buildTransactionDedupKey(tx);
        if (existingKeys.has(key) || importedKeys.has(key)) {
          errors.push(
            `Line ${lineIndex + 1}: duplicate transaction detected (skipped).`,
          );
          continue;
        }

        items.push(tx);
        existingKeys.add(key);
        importedKeys.add(key);
        importedCount += 1;
      } catch (err: any) {
        errors.push(
          `${t(lang, "csv_import_error_line_prefix")} ${lineIndex + 1}: ${t(lang, "csv_import_unknown_error")}`,
        );
      }
    }

    saveLocalTransactions(items);

    return {
      imported: importedCount,
      errors,
    };
  }
  async exportPdf(lang: Language, _transactions?: Transaction[]): Promise<Blob> {
    const res = await fetch(`${API_BASE_URL}export/pdf?lang=${lang}`, {
      method: "GET",
    });

    if (!res.ok) {
      console.error("PDF export error:", res.status, res.statusText);
      throw new Error("PDF export failed");
    }

    return res.blob();
  }
}

/**
 * Helpers for the local-only implementation.
 */
const LS_TRANSACTIONS_KEY = "eigenfolio:transactions";
const LS_NEXT_ID_KEY = "eigenfolio:next-tx-id";

const LS_CONFIG_KEY = "eigenfolio:app-config";

function loadLocalConfig(): AppConfig {
  try {
    const raw = window.localStorage.getItem(LS_CONFIG_KEY);
    if (!raw) {
      return {
        holding_period_days: DEFAULT_HOLDING_PERIOD_DAYS,
        upcoming_holding_window_days: DEFAULT_UPCOMING_WINDOW_DAYS,
      };
    }

    const parsed = JSON.parse(raw) || {};
    const holding =
      typeof parsed.holding_period_days === "number" &&
      Number.isFinite(parsed.holding_period_days)
        ? parsed.holding_period_days
        : DEFAULT_HOLDING_PERIOD_DAYS;

    const upcoming =
      typeof parsed.upcoming_holding_window_days === "number" &&
      Number.isFinite(parsed.upcoming_holding_window_days)
        ? parsed.upcoming_holding_window_days
        : DEFAULT_UPCOMING_WINDOW_DAYS;

    return {
      holding_period_days: holding,
      upcoming_holding_window_days: upcoming,
    };
  } catch (err) {
    console.warn("Failed to load local config", err);
    return {
      holding_period_days: DEFAULT_HOLDING_PERIOD_DAYS,
      upcoming_holding_window_days: DEFAULT_UPCOMING_WINDOW_DAYS,
    };
  }
}

function saveLocalConfig(config: AppConfig): void {
  try {
    window.localStorage.setItem(LS_CONFIG_KEY, JSON.stringify(config));
  } catch (err) {
    console.warn("Failed to save local config", err);
  }
}

export function loadLocalAppConfig(): AppConfig {
  return loadLocalConfig();
}

export function saveLocalAppConfig(config: AppConfig): void {
  saveLocalConfig(config);
}

function loadLocalTransactions(): Transaction[] {
  try {
    const raw = window.localStorage.getItem(LS_TRANSACTIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Transaction[];
  } catch (err) {
    console.warn("Failed to load local transactions", err);
    return [];
  }
}

function saveLocalTransactions(items: Transaction[]): void {
  try {
    window.localStorage.setItem(LS_TRANSACTIONS_KEY, JSON.stringify(items));
  } catch (err) {
    console.warn("Failed to save local transactions", err);
  }
}

export function overwriteLocalTransactions(items: Transaction[]): void {
  saveLocalTransactions(items);
}


function buildTransactionDedupKey(tx: Transaction): string {
  if (tx.tx_id && tx.tx_id.trim() !== "") {
    return `id:${tx.tx_id.trim()}`;
  }

  const asset = (tx.asset_symbol || "").toUpperCase();
  const type = (tx.tx_type || "").toUpperCase();
  const amount = tx.amount != null ? String(tx.amount) : "";
  const price = tx.price_fiat != null ? String(tx.price_fiat) : "";
  const cur = (tx.fiat_currency || "").toUpperCase();
  const ts = tx.timestamp || "";
  const source = tx.source || "";
  const note = tx.note || "";

  return [
    "asset", asset,
    "type", type,
    "amount", amount,
    "price", price,
    "cur", cur,
    "ts", ts,
    "source", source,
    "note", note,
  ].join("|");
}

function getNextLocalId(): number {
  try {
    const raw = window.localStorage.getItem(LS_NEXT_ID_KEY);
    const current = raw ? parseInt(raw, 10) : 1;
    const next = Number.isFinite(current) && current > 0 ? current : 1;
    window.localStorage.setItem(LS_NEXT_ID_KEY, String(next + 1));
    return next;
  } catch {
    // Fallback: compute from current transactions
    const items = loadLocalTransactions();
    const maxId = items.reduce((acc, tx) => (tx.id && tx.id > acc ? tx.id : acc), 0);
    return maxId + 1;
  }
}

export function computeLocalHoldings(transactions: Transaction[]): HoldingsResponse {
  const map = new Map<string, { quantity: number }>();

  for (const tx of transactions) {
    const symbol = tx.asset_symbol || "UNKNOWN";
    const txType = (tx.tx_type || "").toUpperCase();
    const amount = Number(tx.amount || 0);
    if (!Number.isFinite(amount) || amount === 0) continue;

    let sign = 1;
    if (txType === "SELL" || txType === "TRANSFER_OUT") {
      sign = -1;
    }

    const entry = map.get(symbol) ?? { quantity: 0 };
    entry.quantity += sign * amount;
    map.set(symbol, entry);
  }

  const items: HoldingsResponse["items"] = [];
  let portfolio_value_eur: number | null = null;
  let portfolio_value_usd: number | null = null;

  for (const [symbol, entry] of map.entries()) {
    if (Math.abs(entry.quantity) < 1e-12) continue;
    items.push({
      asset_symbol: symbol,
      total_amount: entry.quantity,
      value_eur: null,
      value_usd: null,
    });
  }

  items.sort((a, b) => a.asset_symbol.localeCompare(b.asset_symbol));

  return {
    items,
    portfolio_value_eur,
    portfolio_value_usd,
    fx_rate_eur_usd: null,
    fx_rate_usd_eur: null,
  };
}

export function computeLocalExpiring(transactions: Transaction[], config: AppConfig): ExpiringHolding[] {
  const holdingDays = config.holding_period_days ?? DEFAULT_HOLDING_PERIOD_DAYS;
  const upcomingDays = config.upcoming_holding_window_days ?? DEFAULT_UPCOMING_WINDOW_DAYS;

  if (!Number.isFinite(holdingDays) || holdingDays <= 0) {
    return [];
  }

  const now = new Date();
  const results: ExpiringHolding[] = [];

  for (const tx of transactions) {
    const txType = (tx.tx_type || "").toUpperCase();
    if (!["BUY", "AIRDROP", "REWARD", "STAKING_REWARD"].includes(txType)) {
      continue;
    }
    const ts = new Date(tx.timestamp);
    if (isNaN(ts.getTime())) continue;

    const end = new Date(ts.getTime());
    end.setDate(end.getDate() + holdingDays);

    const diffMs = end.getTime() - now.getTime();
    const remainingDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

    if (remainingDays < -upcomingDays || remainingDays > upcomingDays) {
      continue;
    }

    results.push({
      transaction_id: tx.id,
      asset_symbol: tx.asset_symbol,
      amount: tx.amount,
      timestamp: tx.timestamp,
      holding_period_end: end.toISOString(),
      days_remaining: remainingDays,
    });
  }

  // Optional sort: nearest expiry first
  results.sort((a, b) => a.days_remaining - b.days_remaining);

  return results;
}

/**
 * Local-only implementation using browser storage.
 *
 * NOTES:
 * - Fiat values and FX rates are currently not recalculated. They are left as
 *   null and will be filled in once a local price service is implemented.
 * - PDF export is not implemented here; callers should not switch to
 *   local-only mode for PDF yet.
 */
class LocalDataSource implements PortfolioDataSource {
  async loadInitialData() {
    const txs = loadLocalTransactions();

    const config: AppConfig = loadLocalConfig();

    let holdings = computeLocalHoldings(txs);

    try {
      holdings = await applyPricesToHoldings(holdings);
    } catch (err) {
      console.warn("Failed to enrich holdings with prices", err);
    }

    const expiring = computeLocalExpiring(txs, config);

    return {
      config,
      holdings,
      transactions: txs,
      expiring,
    };
  }

  async saveTransaction(payload: {
    id?: number | null;
    asset_symbol: string;
    tx_type: string;
    amount: number;
    price_fiat: number | null;
    fiat_currency: string;
    timestamp: string;
    source: string | null;
    note: string | null;
    tx_id: string | null;
  }): Promise<void> {
    const items = loadLocalTransactions();
    const isEdit = payload.id != null;

    if (isEdit) {
      const index = items.findIndex((tx) => tx.id === payload.id);
      if (index !== -1) {
        const priceFiat = payload.price_fiat;
        const fiatValue =
          priceFiat != null && Number.isFinite(priceFiat)
            ? priceFiat * payload.amount
            : null;

        items[index] = {
          ...items[index],
          asset_symbol: payload.asset_symbol,
          tx_type: payload.tx_type,
          amount: payload.amount,
          price_fiat: priceFiat,
          fiat_currency: payload.fiat_currency,
          timestamp: payload.timestamp,
          source: payload.source,
          note: payload.note,
          tx_id: payload.tx_id,
          fiat_value: fiatValue,
          // Leave value_eur/value_usd as-is or null; will be recomputed later.
        };
      } else {
        // If not found, treat as new.
        const id = getNextLocalId();
        const priceFiat = payload.price_fiat;
        const fiatValue =
          priceFiat != null && Number.isFinite(priceFiat)
            ? priceFiat * payload.amount
            : null;

        items.push({
          id,
          asset_symbol: payload.asset_symbol,
          tx_type: payload.tx_type,
          amount: payload.amount,
          price_fiat: priceFiat,
          fiat_currency: payload.fiat_currency,
          timestamp: payload.timestamp,
          source: payload.source,
          note: payload.note,
          tx_id: payload.tx_id,
          fiat_value: fiatValue,
          value_eur: null,
          value_usd: null,
        });
      }
    } else {
      const id = getNextLocalId();
      const priceFiat = payload.price_fiat;
      const fiatValue =
        priceFiat != null && Number.isFinite(priceFiat)
          ? priceFiat * payload.amount
          : null;

      items.push({
        id,
        asset_symbol: payload.asset_symbol,
        tx_type: payload.tx_type,
        amount: payload.amount,
        price_fiat: priceFiat,
        fiat_currency: payload.fiat_currency,
        timestamp: payload.timestamp,
        source: payload.source,
        note: payload.note,
        tx_id: payload.tx_id,
        fiat_value: fiatValue,
        value_eur: null,
        value_usd: null,
      });
    }

    saveLocalTransactions(items);
  }

  async deleteTransaction(id: number): Promise<void> {
    const items = loadLocalTransactions();
    const filtered = items.filter((tx) => tx.id !== id);
    saveLocalTransactions(filtered);
  }

  async importCsv(lang: Language, file: File): Promise<CsvImportResult> {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) {
      return { imported: 0, errors: ["CSV has no data rows."] };
    }

    const delimiter = lines[0].includes(";") && !lines[0].includes(",") ? ";" : ",";
    const headerCols = lines[0].split(delimiter).map((c) => c.trim());
    const required = ["asset_symbol", "tx_type", "amount", "timestamp"];

    const missing = required.filter((r) => !headerCols.includes(r));
    if (missing.length > 0) {
      return {
        imported: 0,
        errors: [`Missing required columns: ${missing.join(", ")}`],
      };
    }

    const items = loadLocalTransactions();
    const existingKeys = new Set<string>(items.map((tx) => buildTransactionDedupKey(tx)));
    const importedKeys = new Set<string>();
    const errors: string[] = [];
    let importedCount = 0;

    const versionColIndex = headerCols.indexOf(CSV_SCHEMA_VERSION_COLUMN);
    let csvVersion = 1;
    if (versionColIndex >= 0 && lines.length > 1) {
      const firstDataParts = lines[1].split(delimiter);
      const rawVersion = (firstDataParts[versionColIndex] || "").trim();
      const parsedVersion = parseInt(rawVersion, 10);
      if (Number.isFinite(parsedVersion) && parsedVersion > 0) {
        csvVersion = parsedVersion;
      }
    }
    if (csvVersion > CURRENT_CSV_SCHEMA_VERSION) {
      errors.push(
        t(lang, "csv_import_schema_newer_warning"),
      );
    }

    for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
      const row = lines[lineIndex];
      if (!row.trim()) {
        continue;
      }

      const parts = row.split(delimiter);
      if (parts.length !== headerCols.length) {
        errors.push(`${t(lang, "csv_import_error_line_prefix")} ${lineIndex + 1}: ${t(lang, "csv_import_error_column_mismatch")}`);
        continue;
      }

      const record: Record<string, string> = {};
      headerCols.forEach((col, idx) => {
        let value = parts[idx] ?? "";
        value = value.trim();
        if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
          value = value.slice(1, -1);
        }
        record[col] = value;
      });

      try {
        let rawAmount = record["amount"];
        if (!rawAmount) {
          throw new Error("csv_invalid_amount");
        }
        rawAmount = rawAmount.trim().replace(/\s+/g, "");

        if (rawAmount.includes(",") && rawAmount.includes(".")) {
          const lastComma = rawAmount.lastIndexOf(",");
          const lastDot = rawAmount.lastIndexOf(".");
          if (lastComma > lastDot) {
            rawAmount = rawAmount.replace(/\./g, "").replace(",", ".");
          } else {
            rawAmount = rawAmount.replace(/,/g, "");
          }
        } else if (rawAmount.includes(",")) {
          rawAmount = rawAmount.replace(",", ".");
        }

        const amount = parseFloat(rawAmount);
        if (!Number.isFinite(amount)) {
          throw new Error("csv_invalid_amount");
        }

        const id = getNextLocalId();

        let priceFiat: number | null = null;
        if (record["price_fiat"]) {
          let rawPrice = record["price_fiat"].trim().replace(/\s+/g, "");
          if (rawPrice.includes(",") && rawPrice.includes(".")) {
            const lastComma = rawPrice.lastIndexOf(",");
            const lastDot = rawPrice.lastIndexOf(".");
            if (lastComma > lastDot) {
              rawPrice = rawPrice.replace(/\./g, "").replace(",", ".");
            } else {
              rawPrice = rawPrice.replace(/,/g, "");
            }
          } else if (rawPrice.includes(",")) {
            rawPrice = rawPrice.replace(",", ".");
          }
          const parsedPrice = parseFloat(rawPrice);
          priceFiat = Number.isFinite(parsedPrice) ? parsedPrice : null;
        }

        const fiatValue =
          priceFiat != null && Number.isFinite(priceFiat) ? priceFiat * amount : null;

        const tx: Transaction = {
          id,
          asset_symbol: (record["asset_symbol"] || "").toUpperCase(),
          tx_type: (record["tx_type"] || "").toUpperCase(),
          amount,
          price_fiat: priceFiat,
          fiat_currency: record["fiat_currency"] || "EUR",
          timestamp: record["timestamp"],
          source: record["source"] || null,
          note: record["note"] || null,
          tx_id: record["tx_id"] || null,
          fiat_value: fiatValue,
          value_eur: null,
          value_usd: null,
        };

        const key = buildTransactionDedupKey(tx);
        if (existingKeys.has(key) || importedKeys.has(key)) {
          errors.push(
            `Line ${lineIndex + 1}: duplicate transaction detected (skipped).`,
          );
          continue;
        }

        items.push(tx);
        existingKeys.add(key);
        importedKeys.add(key);
        importedCount += 1;
      } catch (err: any) {
        errors.push(
          `${t(lang, "csv_import_error_line_prefix")} ${lineIndex + 1}: ${t(lang, "csv_import_unknown_error")}`,
        );
      }
    }

    saveLocalTransactions(items);

    return {
      imported: importedCount,
      errors,
    };
  }
  async exportPdf(lang: Language, transactions?: Transaction[]): Promise<Blob> {
    const txs = transactions ?? loadLocalTransactions();

    // Use landscape orientation for better column layout
    const doc = new jsPDF({ orientation: "landscape" });

    const isDe = lang === "de";
    const title = t(lang, "pdf_title");
    const generatedLabel = t(lang, "pdf_generated_label");
    const tzDate = new Date();
    const dateStr = tzDate.toISOString().slice(0, 10);

    const marginLeft = 14;
    const marginTop = 20;
    const marginBottom = 20;
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const usableWidth = pageWidth - marginLeft * 2;

    const decimalSeparator = isDe ? "," : ".";
    const formatNumber = (value: number | null): string => {
      if (value == null || !Number.isFinite(value)) {
        return "";
      }

      const negative = value < 0;
      const x = Math.abs(value);
      let s = String(x);
      if (s.includes("e") || s.includes("E")) {
        s = x.toFixed(10);
      }

      const dotIndex = s.indexOf(".");
      let intPart = dotIndex === -1 ? s : s.slice(0, dotIndex);
      let fracPart = dotIndex === -1 ? "" : s.slice(dotIndex + 1);

      const paddedFrac = (fracPart + "000").slice(0, 3);
      let result = intPart;
      if (paddedFrac.length > 0) {
        result += "." + paddedFrac;
      }

      if (decimalSeparator === ",") {
        result = result.replace(".", ",");
      }

      return negative ? `-${result}` : result;
    };

    doc.setFontSize(16);
    doc.text(title, marginLeft, marginTop);
    doc.setFontSize(10);
    doc.text(`${generatedLabel} ${dateStr}`, marginLeft, marginTop + 6);

    const headerYStart = marginTop + 16;
    let y = headerYStart;

    const colTime = t(lang, "pdf_col_time");
    const colAsset = t(lang, "pdf_col_asset");
    const colType = t(lang, "pdf_col_type");
    const colAmount = t(lang, "pdf_col_amount");
    const colPrice = t(lang, "pdf_col_price");
    const colValue = t(lang, "pdf_col_value");
    const colCur = t(lang, "pdf_col_currency");
    const colSource = t(lang, "pdf_col_source");
    const colTxId = t(lang, "pdf_col_txid");
    const colNote = t(lang, "pdf_col_note");

    const headers = [
      colTime,
      colAsset,
      colType,
      colAmount,
      colPrice,
      colValue,
      colCur,
      colSource,
      colTxId,
      colNote,
    ];

    const rows: string[][] = txs.map((tx) => {
      const timeStr = tx.timestamp
        ? tx.timestamp.substring(0, 19).replace("T", " ")
        : "";
      const amountStr =
        tx.amount != null ? formatNumber(tx.amount) : "";
      const priceStr =
        tx.price_fiat != null ? formatNumber(tx.price_fiat) : "";
      const value =
        tx.fiat_value != null
          ? tx.fiat_value
          : tx.price_fiat != null
          ? tx.price_fiat * tx.amount
          : null;
      const valueStr = value != null ? formatNumber(value) : "";
      const curStr = tx.fiat_currency ?? "";
      const sourceStr = tx.source ?? "";
      const txIdStr = tx.tx_id ?? "";
      const noteStr = tx.note ?? "";

      return [
        timeStr,
        tx.asset_symbol ?? "",
        tx.tx_type ?? "",
        amountStr,
        priceStr,
        valueStr,
        curStr,
        sourceStr,
        txIdStr,
        noteStr,
      ];
    });

    const colCount = headers.length;
    const wrapColumns = new Set<number>([7, 8, 9]); // source, txId, note

    const charWidths: number[] = [];
    for (let col = 0; col < colCount; col++) {
      let maxLen = headers[col].length;
      for (const row of rows) {
        const cell = row[col] ?? "";
        if (cell.length > maxLen) {
          maxLen = cell.length;
        }
      }
      const maxCap = wrapColumns.has(col) ? 40 : 18;
      const effectiveLen = Math.min(maxLen + 1, maxCap);
      charWidths[col] = effectiveLen;
    }

    const baseCharWidth = 2.0;
    const rawWidths = charWidths.map((len) => Math.max(12, len * baseCharWidth));
    const totalRawWidth = rawWidths.reduce((sum, w) => sum + w, 0);
    const scale = totalRawWidth > usableWidth ? usableWidth / totalRawWidth : 1;
    const colWidths = rawWidths.map((w) => w * scale);

    const colX: number[] = [];
    {
      let acc = marginLeft;
      for (const w of colWidths) {
        colX.push(acc);
        acc += w;
      }
    }
    const extraGapBetweenCurAndSource = 6;
    for (let i = 7; i < colX.length; i++) {
      colX[i] += extraGapBetweenCurAndSource;
    }

    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    headers.forEach((h, idx) => {
      doc.text(h, colX[idx], y);
    });

    doc.setFont("helvetica", "normal");

    const lineHeight = 5;
    y += lineHeight + 1;

    let rowIndex = 0;

    const drawHeader = () => {
      doc.setFont("helvetica", "bold");
      y = headerYStart;
      headers.forEach((h, idx) => {
        doc.text(h, colX[idx], y);
      });
      doc.setFont("helvetica", "normal");
      y += lineHeight + 1;
    };

    for (const rowValues of rows) {
      const wrapped: string[][] = rowValues.map((val, idx) => {
        const text = String(val ?? "");
        if (!text) {
          return [""];
        }
        if (!wrapColumns.has(idx)) {
          return [text];
        }
        const cellWidth = colWidths[idx] - 2; // small inner padding
        const width = cellWidth > 0 ? cellWidth : 1;
        return doc.splitTextToSize(text, width) as string[];
      });

      const maxLines = wrapped.reduce(
        (max, lines) => (lines.length > max ? lines.length : max),
        1,
      );
      const rowHeight = maxLines * lineHeight + 2;

      // Page break if needed
      if (y + rowHeight > pageHeight - marginBottom) {
        doc.addPage({ orientation: "landscape" });
        doc.setFontSize(10);
        drawHeader();
        rowIndex = 0;
      }

      // Zebra striping: even rows get a light grey background
      if (rowIndex % 2 === 1) {
        doc.setFillColor(240, 240, 240);
        doc.rect(marginLeft, y - lineHeight + 1, usableWidth, rowHeight, "F");
      }

      // Write cell texts
      wrapped.forEach((lines, idx) => {
        const cellX = colX[idx] + 1;
        let lineY = y;
        for (const line of lines) {
          doc.text(String(line), cellX, lineY);
          lineY += lineHeight;
        }
      });

      y += rowHeight;
      rowIndex += 1;
    }

    const disclaimer = t(lang, "pdf_disclaimer");

    doc.setFontSize(8);
    const disclaimerLines = doc.splitTextToSize(disclaimer, usableWidth) as string[];
    let disclaimerY = y + 8;

    if (disclaimerY + disclaimerLines.length * (lineHeight - 1) > pageHeight - marginBottom) {
      doc.addPage({ orientation: "landscape" });
      disclaimerY = marginTop;
    }

    doc.text(disclaimerLines, marginLeft, disclaimerY);

    return doc.output("blob") as Blob;
  }
}
/**
 * Factory for selecting the appropriate data source implementation.
 */
export function createPortfolioDataSource(mode: DataSourceMode): PortfolioDataSource {
  switch (mode) {
    case "local-only":
      return new LocalDataSource();
    case "cloud":
    default:
      return new CloudDataSource();
  }
}