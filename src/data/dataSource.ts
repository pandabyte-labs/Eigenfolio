import jsPDF from "jspdf";
import { API_BASE_URL, CONFIG_URL, fetchJson } from "./backendApi";
import { applyPricesToHoldings, fetchHistoricalPriceForSymbol, setCoingeckoApiKey } from "./priceService";
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
import { getTxExplorerUrl } from "../domain/assets";
import { getActiveProfileConfig, setActiveProfileConfig, getActiveProfileTransactions, setActiveProfileTransactions, getNextActiveProfileTxId } from "../auth/profileStore";


// Lazily loaded XLSX module so that it is only pulled in when needed.
let xlsxModulePromise: Promise<any> | null = null;

async function getXlsxModule(): Promise<any> {
  if (!xlsxModulePromise) {
    // Use locally vendored SheetJS CE 0.19.3 to avoid vulnerable npm xlsx.
    xlsxModulePromise = import("../vendor/sheetjs/xlsx.mjs");
  }
  return xlsxModulePromise;
}

// Minimal CSV parser that understands quotes and escaped quotes.
// This is used for importing third-party CSV exports (e.g. Bitpanda)
// where fields may contain commas and quotes.
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  result.push(current);
  return result;
}

function normalizeCsvText(text: string): string {
  let result = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        result += ch;
        i++;
        result += text[i];
        continue;
      }
      inQuotes = !inQuotes;
      result += ch;
      continue;
    }

    if ((ch === "\n" || ch === "\r") && inQuotes) {
      result += " ";
      if (ch === "\r" && text[i + 1] === "\n") {
        i++;
      }
      continue;
    }

    result += ch;
  }

  return result;
}


/**
 * Abstraction layer for portfolio data access.
 *
 * This allows us to:
 * - use a backend-based implementation (Traeky backend / cloud),
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

  /** External imports (e.g. Binance XLSX). */
  importBinanceSpotXlsx?(
    lang: Language,
    file: File,
  ): Promise<CsvImportResult>;

  /** External imports for Bitpanda CSV trade history. */
  importBitpandaCsv?(
    lang: Language,
    file: File,
  ): Promise<CsvImportResult>;
}

/**
 * Cloud-based implementation using the existing Traeky API.
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
    const normalized = normalizeCsvText(text);
    const lines = normalized.split(/\r?\n/).filter((l) => l.trim().length > 0);
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

      const parts =
        delimiter === ","
          ? parseCsvLine(row)
          : row.split(delimiter);
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

        const fiatValueFromPrice =
          priceFiat != null && Number.isFinite(priceFiat) ? priceFiat * amount : null;

        let fiatValue: number | null = fiatValueFromPrice;
        if (record["fiat_value"]) {
          let raw = record["fiat_value"].trim().replace(/\s+/g, "");
          if (raw.includes(",") && raw.includes(".")) {
            const lastComma = raw.lastIndexOf(",");
            const lastDot = raw.lastIndexOf(".");
            if (lastComma > lastDot) {
              raw = raw.replace(/\./g, "").replace(",", ".");
            } else {
              raw = raw.replace(/,/g, "");
            }
          } else if (raw.includes(",")) {
            raw = raw.replace(",", ".");
          }
          const parsed = parseFloat(raw);
          if (Number.isFinite(parsed)) {
            fiatValue = parsed;
          }
        }

        let valueEur: number | null = null;
        if (record["value_eur"]) {
          let raw = record["value_eur"].trim().replace(/\s+/g, "");
          if (raw.includes(",") && raw.includes(".")) {
            const lastComma = raw.lastIndexOf(",");
            const lastDot = raw.lastIndexOf(".");
            if (lastComma > lastDot) {
              raw = raw.replace(/\./g, "").replace(",", ".");
            } else {
              raw = raw.replace(/,/g, "");
            }
          } else if (raw.includes(",")) {
            raw = raw.replace(",", ".");
          }
          const parsed = parseFloat(raw);
          if (Number.isFinite(parsed)) {
            valueEur = parsed;
          }
        }

        let valueUsd: number | null = null;
        if (record["value_usd"]) {
          let raw = record["value_usd"].trim().replace(/\s+/g, "");
          if (raw.includes(",") && raw.includes(".")) {
            const lastComma = raw.lastIndexOf(",");
            const lastDot = raw.lastIndexOf(".");
            if (lastComma > lastDot) {
              raw = raw.replace(/\./g, "").replace(",", ".");
            } else {
              raw = raw.replace(/,/g, "");
            }
          } else if (raw.includes(",")) {
            raw = raw.replace(",", ".");
          }
          const parsed = parseFloat(raw);
          if (Number.isFinite(parsed)) {
            valueUsd = parsed;
          }
        }

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
          value_eur: valueEur,
          value_usd: valueUsd,
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
const LS_TRANSACTIONS_KEY = "traeky:transactions";
const LS_NEXT_ID_KEY = "traeky:next-tx-id";

const LS_CONFIG_KEY = "traeky:app-config";

function loadLocalConfig(): AppConfig {
  try {
    return getActiveProfileConfig();
  } catch (err) {
    console.warn("Failed to load profile config", err);
    return {
      holding_period_days: DEFAULT_HOLDING_PERIOD_DAYS,
      upcoming_holding_window_days: DEFAULT_UPCOMING_WINDOW_DAYS,
      base_currency: "EUR",
      price_fetch_enabled: true,
      coingecko_api_key: null,
    };
  }
}


function saveLocalConfig(config: AppConfig): void {
  try {
    setActiveProfileConfig(config);
  } catch (err) {
    console.warn("Failed to save profile config", err);
  }
}


export function loadLocalAppConfig(): AppConfig {
  return loadLocalConfig();
}

export function saveLocalAppConfig(config: AppConfig): void {
  saveLocalConfig(config);
}

export function loadLocalTransactions(): Transaction[] {
  return getActiveProfileTransactions();
}


function saveLocalTransactions(items: Transaction[]): void {
  setActiveProfileTransactions(items);
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
    return getNextActiveProfileTxId();
  } catch {
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
  // Fiat-like symbols are not shown as holdings (these would rather be bank balances).
  const fiatSymbols = new Set<string>([
    "EUR",
    "USD",
    "CHF",
    "GBP",
    "JPY",
    "AUD",
    "CAD",
    "CNY",
  ]);
  let portfolio_value_eur: number | null = null;
  let portfolio_value_usd: number | null = null;

  for (const [symbol, entry] of map.entries()) {
    // Negative or zero quantities are not shown in the holdings overview.
    if (fiatSymbols.has(symbol.toUpperCase())) continue;
    if (!Number.isFinite(entry.quantity) || entry.quantity <= 0) continue;
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
    const asset = (tx.asset_symbol || "").toUpperCase();

    // Skip obvious fiat assets; they should not create holding period entries
    if (asset === "EUR" || asset === "USD") {
      continue;
    }

    if (!["BUY", "AIRDROP", "REWARD", "STAKING_REWARD"].includes(txType)) {
      continue;
    }
    const ts = new Date(tx.timestamp);
    if (isNaN(ts.getTime())) continue;

    const end = new Date(ts.getTime());
    end.setDate(end.getDate() + holdingDays);

    const diffMs = end.getTime() - now.getTime();
    const remainingDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

    if (remainingDays < 0 || remainingDays > upcomingDays) {
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



async function enrichTransactionsWithBaseFiat(
  transactions: Transaction[],
  baseCurrency: "EUR" | "USD",
): Promise<Transaction[]> {
  const enriched: Transaction[] = [];

  for (const tx of transactions) {
    const symbol = (tx.asset_symbol || "").toUpperCase();
    const amount = typeof tx.amount === "number" ? tx.amount : 0;

    // Skip entries that cannot be priced in a meaningful way.
    if (!symbol || !Number.isFinite(amount) || amount === 0) {
      enriched.push(tx);
      continue;
    }

    // Skip obvious fiat asset symbols; they do not need historical price lookup.
    if (symbol === "EUR" || symbol === "USD") {
      enriched.push(tx);
      continue;
    }

    // If we already have both EUR and USD values, keep the transaction as-is.
    const hasBothValues =
      typeof tx.value_eur === "number" &&
      Number.isFinite(tx.value_eur) &&
      typeof tx.value_usd === "number" &&
      Number.isFinite(tx.value_usd);

    if (hasBothValues) {
      enriched.push(tx);
      continue;
    }

    let hist: { eur: number | null; usd: number | null } | null = null;
    try {
      hist = await fetchHistoricalPriceForSymbol(symbol, baseCurrency, tx.timestamp);
    } catch (err) {
      // If the price could not be fetched, keep the original transaction unchanged.
      enriched.push(tx);
      continue;
    }

    if (!hist) {
      enriched.push(tx);
      continue;
    }

    const priceEur =
      typeof hist.eur === "number" && Number.isFinite(hist.eur) ? hist.eur : null;
    const priceUsd =
      typeof hist.usd === "number" && Number.isFinite(hist.usd) ? hist.usd : null;

    const valueEur =
      priceEur != null ? priceEur * amount : tx.value_eur ?? null;
    const valueUsd =
      priceUsd != null ? priceUsd * amount : tx.value_usd ?? null;

    enriched.push({
      ...tx,
      value_eur: valueEur,
      value_usd: valueUsd,
    });
  }

  return enriched;
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
    const config: AppConfig = loadLocalConfig();
    setCoingeckoApiKey(config.coingecko_api_key ?? null);
    const rawTxs = loadLocalTransactions();

    const baseCurrency: "EUR" | "USD" =
      config.base_currency === "USD" ? "USD" : "EUR";

    let transactions = rawTxs;

    if (config.price_fetch_enabled !== false) {
      try {
        transactions = await enrichTransactionsWithBaseFiat(rawTxs, baseCurrency);
      } catch (err) {
        console.warn("Failed to enrich transactions with fiat values", err);
      }
    }

    let holdings = computeLocalHoldings(transactions);

    if (config.price_fetch_enabled !== false) {
      try {
        holdings = await applyPricesToHoldings(holdings);
      } catch (err) {
        console.warn("Failed to enrich holdings with prices", err);
      }
    }

    const expiring = computeLocalExpiring(transactions, config);

    return {
      config,
      holdings,
      transactions,
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
    const normalized = normalizeCsvText(text);
    const lines = normalized.split(/\r?\n/).filter((l) => l.trim().length > 0);
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

      const parts =
        delimiter === ","
          ? parseCsvLine(row)
          : row.split(delimiter);
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

        const fiatValueFromPrice =
          priceFiat != null && Number.isFinite(priceFiat) ? priceFiat * amount : null;

        let fiatValue: number | null = fiatValueFromPrice;
        if (record["fiat_value"]) {
          let raw = record["fiat_value"].trim().replace(/\s+/g, "");
          if (raw.includes(",") && raw.includes(".")) {
            const lastComma = raw.lastIndexOf(",");
            const lastDot = raw.lastIndexOf(".");
            if (lastComma > lastDot) {
              raw = raw.replace(/\./g, "").replace(",", ".");
            } else {
              raw = raw.replace(/,/g, "");
            }
          } else if (raw.includes(",")) {
            raw = raw.replace(",", ".");
          }
          const parsed = parseFloat(raw);
          if (Number.isFinite(parsed)) {
            fiatValue = parsed;
          }
        }

        let valueEur: number | null = null;
        if (record["value_eur"]) {
          let raw = record["value_eur"].trim().replace(/\s+/g, "");
          if (raw.includes(",") && raw.includes(".")) {
            const lastComma = raw.lastIndexOf(",");
            const lastDot = raw.lastIndexOf(".");
            if (lastComma > lastDot) {
              raw = raw.replace(/\./g, "").replace(",", ".");
            } else {
              raw = raw.replace(/,/g, "");
            }
          } else if (raw.includes(",")) {
            raw = raw.replace(",", ".");
          }
          const parsed = parseFloat(raw);
          if (Number.isFinite(parsed)) {
            valueEur = parsed;
          }
        }

        let valueUsd: number | null = null;
        if (record["value_usd"]) {
          let raw = record["value_usd"].trim().replace(/\s+/g, "");
          if (raw.includes(",") && raw.includes(".")) {
            const lastComma = raw.lastIndexOf(",");
            const lastDot = raw.lastIndexOf(".");
            if (lastComma > lastDot) {
              raw = raw.replace(/\./g, "").replace(",", ".");
            } else {
              raw = raw.replace(/,/g, "");
            }
          } else if (raw.includes(",")) {
            raw = raw.replace(",", ".");
          }
          const parsed = parseFloat(raw);
          if (Number.isFinite(parsed)) {
            valueUsd = parsed;
          }
        }

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
          value_eur: valueEur,
          value_usd: valueUsd,
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
  async importBinanceSpotXlsx(lang: Language, file: File): Promise<CsvImportResult> {
    // Read the XLSX file as ArrayBuffer so XLSX can parse it.
    const buffer = await file.arrayBuffer();
    const XLSX = await getXlsxModule();

    // Read workbook; cellDates:true makes date columns proper Date objects.
    const workbook = XLSX.read(buffer, {
      type: "array",
      cellDates: true,
    });

    const firstSheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[firstSheetName];
    if (!sheet) {
      return {
        imported: 0,
        errors: [t(lang, "csv_import_unknown_error")],
      };
    }

    // Validate that the expected Binance columns are present in the header.
    const headerRows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
    }) as unknown as unknown[][];
    const header = (headerRows && headerRows.length > 0 ? headerRows[0] : []) as unknown[];
    const headerCols = header.map((c) => String(c || "").trim());

    const expectedCols = [
      "Date(UTC)",
      "Pair",
      "Base Asset",
      "Quote Asset",
      "Type",
      "Price",
      "Amount",
      "Total",
      "Fee",
      "Fee Coin",
    ];

    const missingCols = expectedCols.filter((col) => !headerCols.includes(col));
    if (missingCols.length > 0) {
      return {
        imported: 0,
        errors: [
          `${t(lang, "external_import_missing_columns_prefix")} ${missingCols.join(", ")}`,
        ],
      };
    }

    // Convert to JSON rows; defval keeps empty strings instead of undefined.
    const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, {
      defval: "",
    });

    const items = loadLocalTransactions();
    const existingKeys = new Set<string>(items.map((tx) => buildTransactionDedupKey(tx)));
    const importedKeys = new Set<string>();
    const errors: string[] = [];
    let importedCount = 0;

    rows.forEach((row, index) => {
      const rowIndex = index + 2; // +2 because header is Excel row 1

      try {
        const rawDate = row["Date(UTC)"];
        const rawBase = row["Base Asset"];
        const rawQuote = row["Quote Asset"];
        const rawType = row["Type"];
        const rawAmount = row["Amount"];
        const rawPrice = row["Price"];
        const rawTotal = row["Total"];
        const rawFee = row["Fee"];
        const rawFeeCoin = row["Fee Coin"];
        const rawPair = row["Pair"];

        if (!rawDate || !rawBase || !rawType || !rawAmount) {
          // Missing required Binance fields – skip this row.
          errors.push(
            `${t(lang, "csv_import_error_line_prefix")} ${rowIndex}: ${t(
              lang,
              "csv_import_unknown_error",
            )}`,
          );
          return;
        }

        // Parse timestamp (Binance sheet is documented as UTC).
        let date: Date;
        if (rawDate instanceof Date) {
          date = rawDate;
        } else if (typeof rawDate === "string") {
          const normalized = rawDate.trim().replace(" ", "T");
          const withZ = normalized.endsWith("Z") ? normalized : `${normalized}Z`;
          date = new Date(withZ);
        } else {
          // Fallback: let JS try to interpret it
          date = new Date(rawDate as any);
        }

        if (isNaN(date.getTime())) {
          errors.push(
            `${t(lang, "csv_import_error_line_prefix")} ${rowIndex}: ${t(
              lang,
              "csv_import_unknown_error",
            )}`,
          );
          return;
        }

        const timestamp = date.toISOString();

        // Parse numbers – parseFloat also understands scientific notation.
        const amount = parseFloat(String(rawAmount));
        if (!Number.isFinite(amount)) {
          errors.push(
            `${t(lang, "csv_import_error_line_prefix")} ${rowIndex}: ${t(
              lang,
              "csv_import_unknown_error",
            )}`,
          );
          return;
        }

        const price =
          rawPrice !== "" && rawPrice != null ? parseFloat(String(rawPrice)) : null;
        const total =
          rawTotal !== "" && rawTotal != null ? parseFloat(String(rawTotal)) : null;

        const baseAsset = String(rawBase || "").trim().toUpperCase();
        const quoteAsset = String(rawQuote || "").trim().toUpperCase();

        const typeUpper = String(rawType || "").toUpperCase();
        let txType = "BUY";
        if (typeUpper.includes("SELL")) {
          txType = "SELL";
        } else if (typeUpper.includes("BUY")) {
          txType = "BUY";
        }

        const id = getNextLocalId();

        // If we have a price, store it; otherwise prefer Total / Amount.
        let priceFiat: number | null = null;
        if (Number.isFinite(price as number)) {
          priceFiat = price as number;
        } else if (Number.isFinite(total as number) && amount !== 0) {
          priceFiat = (total as number) / amount;
        }

        const fiatValue =
          priceFiat != null && Number.isFinite(priceFiat) ? priceFiat * amount : null;

        // Fee is currently stored only in the note to keep the schema simple.
        let note = `Binance trade ${rawPair || `${baseAsset}/${quoteAsset}`}`;
        if (rawFee && rawFeeCoin) {
          note += ` (fee ${rawFee} ${rawFeeCoin})`;
        }

        const tx: Transaction = {
          id,
          asset_symbol: baseAsset,
          tx_type: txType,
          amount,
          price_fiat: priceFiat,
          fiat_currency: quoteAsset || "USDT",
          timestamp,
          source: "BINANCE",
          note,
          tx_id: null,
          fiat_value: fiatValue,
          value_eur: null,
          value_usd: null,
        };

        const key = buildTransactionDedupKey(tx);
        if (existingKeys.has(key) || importedKeys.has(key)) {
          errors.push(`Line ${rowIndex}: duplicate transaction detected (skipped).`);
          return;
        }

        items.push(tx);
        existingKeys.add(key);
        importedKeys.add(key);
        importedCount += 1;
      } catch (err) {
        console.error("Failed to import Binance row", err);
        errors.push(
          `${t(lang, "csv_import_error_line_prefix")} ${rowIndex}: ${t(
            lang,
            "csv_import_unknown_error",
          )}`,
        );
      }
    });

    saveLocalTransactions(items);

    return {
      imported: importedCount,
      errors,
    };
  }




  async importBitpandaCsv(lang: Language, file: File): Promise<CsvImportResult> {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) {
      return {
        imported: 0,
        errors: [t(lang, "csv_import_unknown_error")],
      };
    }

    // Find the header line which contains the Bitpanda trade columns.
    const headerIndex = lines.findIndex(
      (l) => l.includes("Transaction ID") && l.includes("Timestamp"),
    );
    if (headerIndex === -1) {
      return {
        imported: 0,
        errors: [t(lang, "csv_import_unknown_error")],
      };
    }

    const headerParts = parseCsvLine(lines[headerIndex]);
    const headerCols = headerParts.map((c) =>
      c.replace(/^"+|"+$/g, "").trim(),
    );

    const required = [
      "Transaction ID",
      "Timestamp",
      "Transaction Type",
      "In/Out",
      "Amount Fiat",
      "Fiat",
      "Amount Asset",
      "Asset",
      "Asset class",
    ];

    const missing = required.filter((r) => !headerCols.includes(r));
    if (missing.length > 0) {
      return {
        imported: 0,
        errors: [
          `${t(lang, "external_import_missing_columns_prefix")} ${missing.join(
            ", ",
          )}`,
        ],
      };
    }

    const items = loadLocalTransactions();
    const existingKeys = new Set<string>(
      items.map((tx) => buildTransactionDedupKey(tx)),
    );
    const importedKeys = new Set<string>();
    const errors: string[] = [];
    let importedCount = 0;

    for (let i = headerIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      const cols = parseCsvLine(line);
      if (cols.length < headerCols.length) {
        // Skip malformed rows but record a warning.
        errors.push(
          `${t(lang, "csv_import_error_line_prefix")} ${
            i + 1
          }: ${t(lang, "csv_import_unknown_error")}`,
        );
        continue;
      }

      const record: Record<string, string> = {};
      headerCols.forEach((colName, idx) => {
        const raw = cols[idx] ?? "";
        record[colName] = raw.replace(/^"+|"+$/g, "").trim();
      });

      try {
        const assetClass = (record["Asset class"] || "").trim();
        if (assetClass !== "Cryptocurrency") {
          // For now we only import cryptocurrency legs; fiat-only movements are ignored.
          continue;
        }

        const rawTimestamp = record["Timestamp"];
        if (!rawTimestamp) {
          errors.push(
            `${t(lang, "csv_import_error_line_prefix")} ${
              i + 1
            }: ${t(lang, "csv_import_unknown_error")}`,
          );
          continue;
        }

        const date = new Date(rawTimestamp);
        if (isNaN(date.getTime())) {
          errors.push(
            `${t(lang, "csv_import_error_line_prefix")} ${
              i + 1
            }: ${t(lang, "csv_import_unknown_error")}`,
          );
          continue;
        }
        const timestamp = date.toISOString();

        const assetSymbol = (record["Asset"] || "").trim().toUpperCase();
        const amountAsset = parseFloat(record["Amount Asset"] || "0");
        if (!assetSymbol || !Number.isFinite(amountAsset) || amountAsset === 0) {
          // Rows without a meaningful crypto amount are ignored.
          continue;
        }

        const amountFiatRaw = record["Amount Fiat"] || "";
        const amountFiat = parseFloat(amountFiatRaw || "0");
        const fiatCurrency = (record["Fiat"] || "").trim().toUpperCase() || "EUR";

        const txTypeRaw = (record["Transaction Type"] || "").toLowerCase();
        const inOutRaw = (record["In/Out"] || "").toLowerCase();

        let txType = "BUY";
        if (txTypeRaw.includes("staking")) {
          txType = "STAKING_REWARD";
        } else if (txTypeRaw.includes("airdrop") || txTypeRaw.includes("reward")) {
          txType = "REWARD";
        } else if (txTypeRaw.includes("deposit") || txTypeRaw.includes("savings")) {
          txType = "TRANSFER_IN";
        } else if (txTypeRaw.includes("withdraw")) {
          txType = "TRANSFER_OUT";
        } else if (txTypeRaw.includes("trade")) {
          txType = inOutRaw === "incoming" ? "BUY" : "SELL";
        } else {
          txType = inOutRaw === "incoming" ? "BUY" : "SELL";
        }

        const id = getNextLocalId();

        // Prefer explicit fiat amount if present; otherwise fall back to market price.
        let priceFiat: number | null = null;
        if (Number.isFinite(amountFiat) && amountAsset !== 0) {
          priceFiat = amountFiat / amountAsset;
        } else {
          const mktPrice = parseFloat(record["Asset market price"] || "0");
          if (Number.isFinite(mktPrice) && mktPrice > 0) {
            priceFiat = mktPrice;
          }
        }

        let fiatValue: number | null = null;
        if (priceFiat != null && Number.isFinite(priceFiat)) {
          fiatValue = priceFiat * amountAsset;
        } else if (Number.isFinite(amountFiat)) {
          fiatValue = amountFiat;
        }

        const fee = parseFloat(record["Fee"] || "0");
        const feeAsset = (record["Fee asset"] || "").trim();
        const feePercent = record["Fee percent"] || "";
        const spread = record["Spread"] || "";
        const spreadCurrency = record["Spread Currency"] || "";
        const taxFiat = record["Tax Fiat"] || "";

        let note = `Bitpanda ${record["Transaction Type"] || ""} (${record["In/Out"] || ""})`;
        const feeParts: string[] = [];
        if (Number.isFinite(fee) && fee !== 0) {
          feeParts.push(`fee ${fee} ${feeAsset || assetSymbol}`);
        }
        if (feePercent) {
          feeParts.push(`fee% ${feePercent}`);
        }
        if (spread) {
          feeParts.push(`spread ${spread} ${spreadCurrency || fiatCurrency}`);
        }
        if (taxFiat) {
          feeParts.push(`tax ${taxFiat} ${fiatCurrency}`);
        }
        if (feeParts.length > 0) {
          note += ` [${feeParts.join(", ")}]`;
        }

        const tx: Transaction = {
          id,
          asset_symbol: assetSymbol,
          tx_type: txType,
          amount: amountAsset,
          price_fiat: priceFiat,
          fiat_currency: fiatCurrency,
          timestamp,
          source: "BITPANDA",
          note,
          tx_id: record["Transaction ID"] || null,
          fiat_value: fiatValue,
          value_eur: null,
          value_usd: null,
        };

        const key = buildTransactionDedupKey(tx);
        if (existingKeys.has(key) || importedKeys.has(key)) {
          errors.push(
            `${t(lang, "csv_import_error_line_prefix")} ${
              i + 1
            }: duplicate transaction detected (skipped).`,
          );
          continue;
        }

        items.push(tx);
        existingKeys.add(key);
        importedKeys.add(key);
        importedCount += 1;
      } catch (err) {
        console.error("Failed to import Bitpanda row", err);
        errors.push(
          `${t(lang, "csv_import_error_line_prefix")} ${
            i + 1
          }: ${t(lang, "csv_import_unknown_error")}`,
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
    const config = loadLocalConfig();

    // Map internal transaction type codes to human-readable labels in the PDF.
    // The internal codes are kept unchanged for storage and processing.
    const formatTxTypeForPdf = (txType: string | null | undefined): string => {
      const code = (txType || "").toUpperCase();
      switch (code) {
        case "STAKING_REWARD":
          return "STAKING\nREWARD";
        case "TRANSFER_IN":
          return "TRANSFER\n(IN)";
        case "TRANSFER_OUT":
          return "TRANSFER\n(OUT)";
        default:
          return code;
      }
    };

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

    const txIdLinks: (string | null)[] = [];
    const rows: string[][] = txs.map((tx) => {
      const timeStr = tx.timestamp
        ? tx.timestamp.substring(0, 19).replace("T", " ")
        : "";
      const amountStr =
        tx.amount != null ? formatNumber(tx.amount) : "";

      const baseCurrency = config.base_currency === "USD" ? "USD" : "EUR";

      let totalValue: number | null = null;
      if (baseCurrency === "USD") {
        if (typeof tx.value_usd === "number" && Number.isFinite(tx.value_usd)) {
          totalValue = tx.value_usd;
        } else if (
          tx.fiat_currency === "USD" &&
          typeof tx.fiat_value === "number" &&
          Number.isFinite(tx.fiat_value)
        ) {
          totalValue = tx.fiat_value;
        }
      } else {
        if (typeof tx.value_eur === "number" && Number.isFinite(tx.value_eur)) {
          totalValue = tx.value_eur;
        } else if (
          tx.fiat_currency === "EUR" &&
          typeof tx.fiat_value === "number" &&
          Number.isFinite(tx.fiat_value)
        ) {
          totalValue = tx.fiat_value;
        }
      }

      let pricePerUnit: number | null = null;
      if (totalValue != null && tx.amount != null && Number.isFinite(tx.amount) && tx.amount !== 0) {
        pricePerUnit = totalValue / tx.amount;
      }

      const priceStr =
        pricePerUnit != null ? formatNumber(pricePerUnit) : "";
      const valueStr =
        totalValue != null ? formatNumber(totalValue) : "";
      const curStr = baseCurrency;
      const sourceStr = tx.source ?? "";
      const txIdStr = tx.tx_id ?? "";
      const noteStr = tx.note ?? "";
      const txExplorerUrl = getTxExplorerUrl(tx.asset_symbol ?? null, tx.tx_id ?? null);
      txIdLinks.push(txExplorerUrl);

      return [
        timeStr,
        tx.asset_symbol ?? "",
        formatTxTypeForPdf(tx.tx_type),
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
      // Control how "wide" each column can become in characters.
      // Time and type can be a bit narrower because we already break them into two lines.
      // Amount and value get a bit more room for readability.
      let maxCap: number;
      if (col === 0) {
        // time
        maxCap = 16;
      } else if (col === 2) {
        // type (can be quite narrow because it is always broken into two lines)
        maxCap = 10;
      } else if (col === 3 || col === 5) {
        // amount, value - give these a bit more space
        maxCap = 26;
      } else if (col === 4) {
        // price
        maxCap = 22;
      } else if (col === 7) {
        // Source: wrap earlier to avoid pushing the note too far
        maxCap = 20;
      } else if (col === 8) {
        // TX-ID: wrap earlier so hashes/ids do not stretch the layout
        maxCap = 18;
      } else if (col === 9) {
        // Note: wrap earlier so the column does not dominate the width
        maxCap = 16;
      } else if (wrapColumns.has(col)) {
        maxCap = 20;
      } else {
        maxCap = 18;
      }

      const effectiveLen = Math.min(maxLen + 1, maxCap);
      // Do not let columns become too narrow so that headers remain readable.
      charWidths[col] = Math.max(6, effectiveLen);
    }

    const baseCharWidth = 2.0;
    const rawWidths = charWidths.map((len) => Math.max(12, len * baseCharWidth));
    const totalRawWidth = rawWidths.reduce((sum, w) => sum + w, 0);
    const scale = totalRawWidth > usableWidth ? usableWidth / totalRawWidth : 1;
    const colWidths = rawWidths.map((w) => w * scale);

    const colX: number[] = [];
    {
      const colGap = 2;
      let acc = marginLeft;
      for (const w of colWidths) {
        colX.push(acc);
        acc += w + colGap;
      }
    }
    const extraGapBetweenCurAndSource = 6;
    for (let i = 7; i < colX.length; i++) {
      colX[i] += extraGapBetweenCurAndSource;
    }

    const tableFontSize = 9;
    const tableFontFamily = "times";
    const lineHeight = 4.5;

    doc.setFontSize(tableFontSize);
    doc.setFont(tableFontFamily, "bold");
    headers.forEach((h, idx) => {
      doc.text(h, colX[idx], y);
    });

    doc.setFont(tableFontFamily, "normal");
    y += lineHeight + 1;

    let rowIndex = 0;

    const drawHeader = () => {
      doc.setFontSize(tableFontSize);
      doc.setFont(tableFontFamily, "bold");
      y = headerYStart;
      headers.forEach((h, idx) => {
        doc.text(h, colX[idx], y);
      });
      doc.setFont(tableFontFamily, "normal");
      y += lineHeight + 1;
    };

    for (const rowValues of rows) {
      const wrapped: string[][] = rowValues.map((val, idx) => {
        const text = String(val ?? "");
        if (!text) {
          return [""];
        }
        // For the type column we always respect manual line breaks
        // so that values like "STAKING REWARD" or "TRANSFER (OUT)"
        // can be split across two lines in a controlled way.
        if (idx === 2) {
          const parts = text.split("\n");
          return parts.length > 0 ? parts : [text];
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
        doc.setFontSize(tableFontSize);
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

    // Add an invisible clickable link for the TX-ID column (column index 8)
    if (idx === 8) {
      const link = txIdLinks[rowIndex] || null;
      if (link && line === lines[0]) {
        const cellWidth = colWidths[idx] - 2;
        const width = cellWidth > 0 ? cellWidth : 1;
        const height = rowHeight - 2;
        try {
          doc.link(cellX, y, width, height, { url: link });
        } catch {
          // ignore link errors to avoid breaking PDF generation
        }
      }
    }

    lineY += lineHeight;
  }
});
;

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