export type AssetMetadata = {
  symbol: string;
  name: string;
  /**
   * Optional base URL for a transaction explorer where the tx-id will be appended.
   * Example: "https://etherscan.io/tx/".
   */
  explorerBaseUrl?: string;
  /**
   * Optional CoinGecko asset id for price lookups (e.g. "bitcoin", "matic-network").
   */
  coingeckoId?: string;
};

// Note: This list intentionally contains a curated set of popular assets.
// It can be extended at any time without touching the calling code.
// TEST: { symbol: "", name: "", explorerBaseUrl: "", coingeckoId: "" },

const ASSET_METADATA: Record<string, AssetMetadata> = {
  AAVE: { symbol: "AAVE", name: "Aave", explorerBaseUrl: "https://etherscan.io/tx/", coingeckoId: "aave" },
  ADA: { symbol: "ADA", name: "Cardano", explorerBaseUrl: "https://cardanoscan.io/transaction/", coingeckoId: "cardano" },
  ALGO: { symbol: "ALGO", name: "Algorand", explorerBaseUrl: "https://allo.info/tx/", coingeckoId: "algorand" },
  APT: { symbol: "APT", name: "Aptos", explorerBaseUrl: "https://aptoscan.com/transaction/", coingeckoId: "aptos" },
  ARB: { symbol: "ARB", name: "Arbitrum", explorerBaseUrl: "https://arbiscan.io/tx/", coingeckoId: "arbitrum" },
  ATOM: { symbol: "ATOM", name: "Cosmos Hub", explorerBaseUrl: "https://www.mintscan.io/cosmos/txs/", coingeckoId: "cosmos" },
  AVAX: { symbol: "AVAX", name: "Avalanche", explorerBaseUrl: "https://snowtrace.io/tx/", coingeckoId: "avalanche-2" },
  BCH: { symbol: "BCH", name: "Bitcoin Cash", explorerBaseUrl: "https://blockchair.com/bitcoin-cash/transaction/", coingeckoId: "bitcoin-cash" },
  BNB: { symbol: "BNB", name: "BNB", explorerBaseUrl: "https://bscscan.com/tx/", coingeckoId: "binancecoin" },
  BTC: { symbol: "BTC", name: "Bitcoin", explorerBaseUrl: "https://mempool.space/tx/", coingeckoId: "bitcoin" },
  CRO: { symbol: "CRO", name: "Cronos", explorerBaseUrl: "https://cronoscan.com/tx/", coingeckoId: "crypto-com-chain" },
  DOGE: { symbol: "DOGE", name: "Dogecoin", explorerBaseUrl: "https://dogechain.info/tx/", coingeckoId: "dogecoin" },
  DOT: { symbol: "DOT", name: "Polkadot", explorerBaseUrl: "https://polkascan.io/polkadot/transaction/", coingeckoId: "polkadot" },
  ETC: { symbol: "ETC", name: "Ethereum Classic", explorerBaseUrl: "https://etcblockexplorer.com/tx/", coingeckoId: "ethereum-classic" },
  ETH: { symbol: "ETH", name: "Ethereum", explorerBaseUrl: "https://etherscan.io/tx/", coingeckoId: "ethereum" },
  FIL: { symbol: "FIL", name: "Filecoin", explorerBaseUrl: "https://filfox.info/en/message/", coingeckoId: "filecoin" },
  GRT: { symbol: "GRT", name: "The Graph", explorerBaseUrl: "https://etherscan.io/tx/", coingeckoId: "the-graph" },
  GT: { symbol: "GT", name: "Gate", explorerBaseUrl: "https://www.gatescan.org/gatelayer/tx/", coingeckoId: "gatechain-token" },
  HBAR: { symbol: "HBAR", name: "Hedera", explorerBaseUrl: "https://hashscan.io/mainnet/transaction/", coingeckoId: "hedera-hashgraph" },
  HYPE: { symbol: "HYPE", name: "Hyperliquid", explorerBaseUrl: "https://app.hyperliquid.xyz/explorer/tx/", coingeckoId: "hyperliquid" },
  INJ: { symbol: "INJ", name: "Injective", explorerBaseUrl: "https://www.mintscan.io/injective/txs/", coingeckoId: "injective-protocol" },
  IOTA: { symbol: "IOTA", name: "IOTA", explorerBaseUrl: "https://explorer.iota.org/txblock/", coingeckoId: "iota" },
  KAS: { symbol: "KAS", name: "Kaspa", explorerBaseUrl: "https://kas.fyi/transaction/", coingeckoId: "kaspa" },
  KCS: { symbol: "KCS", name: "KuCoin", explorerBaseUrl: "https://scan.kcc.io/tx/", coingeckoId: "kucoin-shares" },
  LINK: { symbol: "LINK", name: "Chainlink", explorerBaseUrl: "https://etherscan.io/tx/", coingeckoId: "chainlink" },
  LTC: { symbol: "LTC", name: "Litecoin", explorerBaseUrl: "https://blockchair.com/litecoin/transaction/", coingeckoId: "litecoin" },
  MANA: { symbol: "MANA", name: "Decentraland", explorerBaseUrl: "https://etherscan.io/tx/", coingeckoId: "decentraland" },
  MATIC: { symbol: "MATIC", name: "Polygon", explorerBaseUrl: "https://polygonscan.com/tx/", coingeckoId: "matic-network" },
  OP: { symbol: "OP", name: "Optimism", explorerBaseUrl: "https://optimistic.etherscan.io/tx/", coingeckoId: "optimism" },
  RUNE: { symbol: "RUNE", name: "THORChain", explorerBaseUrl: "https://viewblock.io/thorchain/tx/", coingeckoId: "thorchain" },
  SAND: { symbol: "SAND", name: "The Sandbox", explorerBaseUrl: "https://etherscan.io/tx/", coingeckoId: "the-sandbox" },
  SHIB: { symbol: "SHIB", name: "Shiba Inu", explorerBaseUrl: "https://etherscan.io/tx/", coingeckoId: "shiba-inu" },
  SMR: { symbol: "SMR", name: "Shimmer", explorerBaseUrl: "https://explorer.shimmer.network/shimmer/block/", coingeckoId: "shimmer" },
  SOL: { symbol: "SOL", name: "Solana", explorerBaseUrl: "https://solscan.io/tx/", coingeckoId: "solana" },
  STX: { symbol: "STX", name: "Stacks", explorerBaseUrl: "https://explorer.hiro.so/txid/", coingeckoId: "stacks" },
  SUI: { symbol: "SUI", name: "Sui", explorerBaseUrl: "https://explorer.sui.io/tx/", coingeckoId: "sui" },
  TON: { symbol: "TON", name: "Toncoin", explorerBaseUrl: "https://tonviewer.com/transaction/", coingeckoId: "toncoin" },
  TRX: { symbol: "TRX", name: "TRON", explorerBaseUrl: "https://tronscan.org/#/transaction/", coingeckoId: "tron" },
  UNI: { symbol: "UNI", name: "Uniswap", explorerBaseUrl: "https://etherscan.io/tx/", coingeckoId: "uniswap" },
  USDC: { symbol: "USDC", name: "USD Coin", explorerBaseUrl: "https://etherscan.io/tx/", coingeckoId: "usd-coin" },
  USDT: { symbol: "USDT", name: "Tether", explorerBaseUrl: "https://etherscan.io/tx/", coingeckoId: "tether" },
  VET: { symbol: "VET", name: "VeChain", explorerBaseUrl: "https://vechainstats.com/transaction/", coingeckoId: "vechain" },
  XLM: { symbol: "XLM", name: "Stellar", explorerBaseUrl: "https://stellarchain.io/tx/", coingeckoId: "stellar" },
  XMR: { symbol: "XMR", name: "Monero", explorerBaseUrl: "https://localmonero.co/blocks/tx/", coingeckoId: "monero" },
  XRP: { symbol: "XRP", name: "XRP", explorerBaseUrl: "https://livenet.xrpl.org/transactions/", coingeckoId: "ripple" },
  ZEC: { symbol: "ZEC", name: "Zcash", explorerBaseUrl: "https://mainnet.zcashexplorer.app/transactions/", coingeckoId: "zcash" },
};

export function getAssetMetadata(symbolOrName: string | null | undefined): AssetMetadata | null {
  if (!symbolOrName) {
    return null;
  }
  const key = symbolOrName.trim().toUpperCase();

  // 1) Direct symbol lookup (e.g. "BTC")
  const bySymbol = ASSET_METADATA[key];
  if (bySymbol) {
    return bySymbol;
  }

  // 2) Fallback: lookup by full name (e.g. "BITCOIN" -> BTC)
  for (const meta of Object.values(ASSET_METADATA)) {
    if (meta.name.toUpperCase() === key) {
      return meta;
    }
  }

  return null;
}

export function normalizeAssetSymbol(input: string | null | undefined): string | null {
  if (!input) {
    return null;
  }
  const meta = getAssetMetadata(input);
  if (meta) {
    return meta.symbol;
  }
  return input.trim();
}

export function getTxExplorerUrl(
  symbol: string | null | undefined,
  txId: string | null | undefined,
): string | null {
  if (!symbol || !txId) {
    return null;
  }
  const meta = getAssetMetadata(symbol);
  if (!meta || !meta.explorerBaseUrl) {
    return null;
  }
  return `${meta.explorerBaseUrl}${txId}`;
}

export function getCoingeckoIdForSymbol(symbol: string | null | undefined): string | null {
  if (!symbol) {
    return null;
  }
  const meta = getAssetMetadata(symbol);
  return meta?.coingeckoId ?? null;
}

