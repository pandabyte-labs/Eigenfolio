import type { HoldingsResponse } from "../domain/types";

/**
 * Simple client-side price service using a public API (e.g. CoinGecko).
 *
 * NOTE:
 * - This service is intentionally frontend-only so that the standalone
 *   (local-only) mode can fetch prices without going through the backend.
 * - The implementation uses a small symbol -> CoinGecko ID mapping and
 *   falls back to heuristic mapping for unknown symbols.
 */

const COINGECKO_API = "https://api.coingecko.com/api/v3/simple/price";

const SYMBOL_TO_COINGECKO_ID: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  ADA: "cardano",
  BNB: "binancecoin",
  XRP: "ripple",
  AVAX: "avalanche-2",
  DOT: "polkadot",
  MATIC: "matic-network",
  DOGE: "dogecoin",
};

type SupportedFiat = "EUR" | "USD";

type PriceMap = Record<string, { eur?: number; usd?: number }>;

type PriceCacheEntry = {
  eur?: number;
  usd?: number;
  fetched_at: number;
};

const PRICE_CACHE_KEY = "traeky:price-cache-v1";
/**
 * How long a cached price is considered "fresh" before we try to refresh it
 * from the price API again. We intentionally pick a relatively long interval
 * to reduce API calls and avoid rate limits.
 */
const PRICE_CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

let priceCache: Record<string, PriceCacheEntry> | null = null;
let priceCacheLoaded = false;

/**
 * Very small in-memory / localStorage-backed cache for prices so that we do
 * not have to hit the price API for every page load or every small change.
 * This also helps to stay below public API rate limits.
 */
function ensurePriceCacheLoaded(): void {
  if (priceCacheLoaded) return;
  priceCacheLoaded = true;
  try {
    const raw = window.localStorage.getItem(PRICE_CACHE_KEY);
    if (!raw) {
      priceCache = {};
      return;
    }
    const parsed = JSON.parse(raw) as Record<string, PriceCacheEntry>;
    if (parsed && typeof parsed === "object") {
      priceCache = parsed;
    } else {
      priceCache = {};
    }
  } catch {
    priceCache = {};
  }
}

function persistPriceCache(): void {
  if (!priceCache) return;
  try {
    window.localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(priceCache));
  } catch {
    // ignore persistence errors and keep the in-memory cache only
  }
}

let rateLimitUntil: number | null = null;
const RATE_LIMIT_BACKOFF_MS = 60 * 1000; // 1 minute

// Throttle historical price requests to avoid hitting public API limits
let lastHistoricalRequestAt: number | null = null;
const MIN_HISTORICAL_REQUEST_INTERVAL_MS = 1500; // 1.5 seconds between history calls

// If we detect repeated network/CORS errors when calling the public price API,
// we avoid spamming the console but still keep trying after a backoff window.
let priceApiErrorLogged = false;

// Optional CoinGecko API key used for requests from this browser session.
let coingeckoApiKey: string | null = null;

export function setCoingeckoApiKey(key: string | null): void {
  const trimmed = key?.trim() ?? "";
  coingeckoApiKey = trimmed.length > 0 ? trimmed : null;
}

/**
 * Expose a minimal status about the price API for the UI.
 *
 * This does not trigger any requests; it simply reflects whether we have
 * seen at least one network / CORS / HTTP error in this session. The caller
 * can use this to show a small notice that price fetching is degraded but
 * will be retried with backoff.
 */
export function getPriceApiStatus(): { hasError: boolean } {
  return { hasError: priceApiErrorLogged };
}

function getCachedQuote(sym: string): { eur?: number; usd?: number } | null {
  if (!priceCache) return null;
  const upper = sym.toUpperCase();
  const entry = priceCache[upper];
  if (!entry) return null;
  return {
    eur: entry.eur,
    usd: entry.usd,
  };
}

function mapSymbolToId(symbol: string): string | null {
  const upper = symbol.toUpperCase();
  if (SYMBOL_TO_COINGECKO_ID[upper]) {
    return SYMBOL_TO_COINGECKO_ID[upper];
  }
  // Heuristic fallback: try lowercase symbol as ID
  return symbol ? symbol.toLowerCase() : null;
}


export async function fetchPricesForSymbols(
  symbols: string[],
  fiats: SupportedFiat[] = ["EUR", "USD"],
): Promise<PriceMap> {
const uniqueSymbols = Array.from(new Set(symbols.map((s) => s.toUpperCase())));
  if (uniqueSymbols.length === 0) {
    return {};
  }

  ensurePriceCacheLoaded();

  const result: PriceMap = {};
  const symbolsNeedingRequest: string[] = [];
  const now = Date.now();

  for (const sym of uniqueSymbols) {
    const cached = getCachedQuote(sym);
    if (cached) {
      result[sym] = {
        eur: cached.eur,
        usd: cached.usd,
      };
    } else {
      symbolsNeedingRequest.push(sym);
    }
  }

  // If everything could be satisfied from cache, skip the network call.
  if (symbolsNeedingRequest.length === 0) {
    return result;
  }

  // If we recently saw a rate limit error, back off from hitting the API.
  if (rateLimitUntil && now < rateLimitUntil) {
    return result;
  }

  const ids = symbolsNeedingRequest
    .map(mapSymbolToId)
    .filter((id): id is string => !!id);

  if (ids.length === 0) {
    return result;
  }

  const vsCurrencies = fiats
    .map((f) => f.toLowerCase())
    .join(",");

  const params = new URLSearchParams({
    ids: ids.join(","),
    vs_currencies: vsCurrencies,
  });

  if (coingeckoApiKey) {
    params.set("x_cg_demo_api_key", coingeckoApiKey);
  }

  const url = `${COINGECKO_API}?${params.toString()}`;

  try {
    const res = await fetch(url);
    lastHistoricalRequestAt = Date.now();
    if (!res.ok) {
      if (res.status === 429) {
        // Simple backoff window to avoid hammering the public API.
        rateLimitUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
        console.warn("Price API rate-limited", res.status, res.statusText);
      } else {
        console.warn("Price API error", res.status, res.statusText);
      }
      return result;
    }

    const data = (await res.json()) as Record<
      string,
      { eur?: number; usd?: number }
    >;

    const idToSymbol: Record<string, string[]> = {};
    for (const sym of symbolsNeedingRequest) {
      const id = mapSymbolToId(sym);
      if (!id) continue;
      if (!idToSymbol[id]) {
        idToSymbol[id] = [];
      }
      idToSymbol[id].push(sym);
    }

    const updatedCache = priceCache ?? {};
    for (const [id, price] of Object.entries(data)) {
      const syms = idToSymbol[id] ?? [];
      for (const sym of syms) {
        const upper = sym.toUpperCase();
        const quote = {
          eur: price.eur,
          usd: price.usd,
        };
        result[upper] = quote;
        updatedCache[upper] = {
          eur: price.eur,
          usd: price.usd,
          fetched_at: Date.now(),
        };
      }
    }

    priceCache = updatedCache;
    persistPriceCache();

    return result;
  } catch (err) {
    if (!priceApiErrorLogged) {
      console.warn("Failed to fetch prices", err);
      priceApiErrorLogged = true;
    }
    // Back off further calls for a short window to avoid hammering the API.
    rateLimitUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
    return result;
  }
}

/**
 * Apply prices to a HoldingsResponse.
 *
 * This keeps the structure of the holdings and fills:
 * - per-asset `value_eur` / `value_usd`
 * - aggregate `portfolio_value_eur` / `portfolio_value_usd`
 *
 * FX rates are left as null for now.
 */

export type AssetPriceCacheEntry = PriceCacheEntry;

export type AssetPriceCache = Record<string, AssetPriceCacheEntry>;

/**
 * Return a snapshot of the current in-memory/localStorage price cache.
 *
 * This snapshot can be embedded into portfolio backups so that historical
 * price information does not have to be fetched again from the public API
 * when restoring or syncing.
 */
export function getPriceCacheSnapshot(): AssetPriceCache {
  ensurePriceCacheLoaded();
  if (!priceCache) {
    return {};
  }
  // Shallow clone is sufficient because entries are plain data objects.
  return { ...priceCache };
}

/**
 * Historical price cache (date-based, client-side only).
 *
 * We store historical prices per (symbol, date) so we can avoid hitting the
 * history endpoint repeatedly when importing or editing transactions with a
 * timestamp in the past.
 */
type HistoricalPriceCacheEntry = PriceCacheEntry;

type HistoricalPriceCache = Record<string, HistoricalPriceCacheEntry>;

const HISTORICAL_PRICE_CACHE_KEY = "traeky:price-cache-historical-v1";

let historicalPriceCache: HistoricalPriceCache | null = null;

function ensureHistoricalPriceCacheLoaded(): void {
  if (historicalPriceCache !== null) return;
  try {
    const raw = window.localStorage.getItem(HISTORICAL_PRICE_CACHE_KEY);
    if (!raw) {
      historicalPriceCache = {};
      return;
    }
    const parsed = JSON.parse(raw) as HistoricalPriceCache;
    if (parsed && typeof parsed === "object") {
      historicalPriceCache = parsed;
    } else {
      historicalPriceCache = {};
    }
  } catch {
    historicalPriceCache = {};
  }
}

function persistHistoricalPriceCache(): void {
  if (!historicalPriceCache) return;
  try {
    window.localStorage.setItem(
      HISTORICAL_PRICE_CACHE_KEY,
      JSON.stringify(historicalPriceCache),
    );
  } catch {
    // Ignore persistence errors and keep the in-memory cache only.
  }
}

function extractDateKey(timestampIso: string | null | undefined): string {
  if (!timestampIso) return "";
  // Expect an ISO string like "YYYY-MM-DDTHH:mm:ss" or "YYYY-MM-DD".
  // We only care about the calendar date.
  return timestampIso.slice(0, 10);
}

function toCoingeckoHistoryDateParam(dateKey: string): string | null {
  if (!dateKey) return null;
  const parts = dateKey.split("-");
  if (parts.length !== 3) return null;
  const [year, month, day] = parts;
  if (!year || !month || !day) return null;
  // CoinGecko expects "DD-MM-YYYY".
  return `${day}-${month}-${year}`;
}

/**
 * Fetch a historical price for a single symbol at the date of the given
 * timestamp, if supported by the public price API.
 *
 * This uses CoinGecko's `/coins/{id}/history` endpoint and caches results
 * per (symbol, date) in localStorage to avoid hitting the API repeatedly.
 */
export async function fetchHistoricalPriceForSymbol(
  symbol: string,
  fiat: SupportedFiat,
  timestampIso: string,
): Promise<{ eur: number | null; usd: number | null } | null> {
const upper = symbol.toUpperCase();
  const dateKey = extractDateKey(timestampIso);
  if (!dateKey) return null;

  // Reuse the simple rate-limit gate used by the spot-price fetcher.
  if (rateLimitUntil && Date.now() < rateLimitUntil) {
    return null;
  }

  // Basic client-side throttling to stay below public API rate limits,
  // especially when enriching many historical transactions in a row.
  if (lastHistoricalRequestAt != null) {
    const elapsed = Date.now() - lastHistoricalRequestAt;
    if (elapsed < MIN_HISTORICAL_REQUEST_INTERVAL_MS) {
      await new Promise((resolve) =>
        setTimeout(resolve, MIN_HISTORICAL_REQUEST_INTERVAL_MS - elapsed),
      );
    }
  }

  ensureHistoricalPriceCacheLoaded();

  const cacheKey = `${upper}:${dateKey}`;
  const cached = historicalPriceCache ? historicalPriceCache[cacheKey] : undefined;
  if (cached) {
    return {
      eur: typeof cached.eur === "number" ? cached.eur : null,
      usd: typeof cached.usd === "number" ? cached.usd : null,
    };
  }

  const id = mapSymbolToId(upper);
  if (!id) return null;

  const dateParam = toCoingeckoHistoryDateParam(dateKey);
  if (!dateParam) return null;

  const params = new URLSearchParams({
    date: dateParam,
    localization: "false",
  });

  if (coingeckoApiKey) {
    params.set("x_cg_demo_api_key", coingeckoApiKey);
  }

  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(
    id,
  )}/history?${params.toString()}`;

  try {
    const res = await fetch(url);
    lastHistoricalRequestAt = Date.now();
    if (!res.ok) {
      if (res.status === 429) {
        // Back off if we hit the rate limit.
        rateLimitUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
        console.warn(
          "Historical price API rate-limited",
          res.status,
          res.statusText,
        );
      } else {
        console.warn(
          "Historical price API error",
          res.status,
          res.statusText,
        );
      }
      return null;
    }

    const data: any = await res.json();
    const market = data && data.market_data && data.market_data.current_price;
    if (
      !market ||
      (typeof market.eur !== "number" && typeof market.usd !== "number")
    ) {
      return null;
    }

    const eur = typeof market.eur === "number" ? market.eur : null;
    const usd = typeof market.usd === "number" ? market.usd : null;

    const entry: HistoricalPriceCacheEntry = {
      eur: eur ?? undefined,
      usd: usd ?? undefined,
      fetched_at: Date.now(),
    };

    const updated: HistoricalPriceCache = historicalPriceCache ?? {};
    updated[cacheKey] = entry;
    historicalPriceCache = updated;
    persistHistoricalPriceCache();

    return { eur, usd };
  } catch (err) {
    if (!priceApiErrorLogged) {
      console.warn("Failed to fetch historical price", err);
      priceApiErrorLogged = true;
    }
    // Back off further calls for a short window to avoid hammering the API.
    rateLimitUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
    return null;
  }
}

/**
 * Hydrate the price cache from a previously stored snapshot.
 *
 * This is used when restoring from an encrypted backup or when loading data
 * that was synced from the Traeky Cloud. It allows the frontend to
 * reuse historical token prices without additional API requests.
 */
export function hydratePriceCache(snapshot: AssetPriceCache): void {
  ensurePriceCacheLoaded();
  priceCache = { ...snapshot };
  persistPriceCache();
}

export async function applyPricesToHoldings(
  holdings: HoldingsResponse,
  primaryFiat: SupportedFiat = "EUR",
): Promise<HoldingsResponse> {
  const symbols = holdings.items.map((h) => h.asset_symbol);
  const prices = await fetchPricesForSymbols(symbols);

  let portfolioEur: number | null = null;
  let portfolioUsd: number | null = null;

  const updatedItems = holdings.items.map((item) => {
    const symKey = item.asset_symbol.toUpperCase();
    const quote = prices[symKey];
    let valueEur: number | null = null;
    let valueUsd: number | null = null;

    if (quote) {
      if (typeof quote.eur === "number" && Number.isFinite(quote.eur)) {
        valueEur = quote.eur * item.total_amount;
        portfolioEur = (portfolioEur ?? 0) + valueEur;
      }
      if (typeof quote.usd === "number" && Number.isFinite(quote.usd)) {
        valueUsd = quote.usd * item.total_amount;
        portfolioUsd = (portfolioUsd ?? 0) + valueUsd;
      }
    }

    return {
      ...item,
      value_eur: valueEur,
      value_usd: valueUsd,
    };
  });

  return {
    ...holdings,
    items: updatedItems,
    portfolio_value_eur: portfolioEur,
    portfolio_value_usd: portfolioUsd,
    fx_rate_eur_usd: null,
    fx_rate_usd_eur: null,
  };
}
