/* Shared domain types for Traeky frontend. */

export type Transaction = {
  id: number;
  asset_symbol: string;
  tx_type: string;
  amount: number;
  price_fiat?: number | null;
  fiat_currency: string;
  timestamp: string;
  source?: string | null;
  note?: string | null;
  tx_id?: string | null;
  fiat_value?: number | null;
  value_eur?: number | null;
  value_usd?: number | null;
};

export type HoldingsItem = {
  asset_symbol: string;
  total_amount: number;
  value_eur?: number | null;
  value_usd?: number | null;
};

export type HoldingsResponse = {
  items: HoldingsItem[];
  portfolio_value_eur?: number | null;
  portfolio_value_usd?: number | null;
  fx_rate_eur_usd?: number | null;
  fx_rate_usd_eur?: number | null;
};

export type CsvImportResult = {
  imported: number;
  errors: string[];
};

export type AppConfig = {
  holding_period_days: number;
  upcoming_holding_window_days: number;
  base_currency: "EUR" | "USD";
  // Whether the app should query CoinGecko for prices from this browser.
  price_fetch_enabled?: boolean;
  // Optional CoinGecko API key used for price requests.
  coingecko_api_key?: string | null;
};

export type ExpiringHolding = {
  transaction_id: number;
  asset_symbol: string;
  amount: number;
  timestamp: string;
  holding_period_end: string;
  days_remaining: number;
};

export type ImportProgress = {
  kind: "local_csv" | "binance" | "bitpanda";
  current: number;
  total: number;
};


