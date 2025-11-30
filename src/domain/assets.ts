export type AssetMetadata = {
  symbol: string;
  name: string;
  /**
   * Optional base URL for a transaction explorer where the tx-id will be appended.
   * Example: "https://etherscan.io/tx/".
   */
  explorerBaseUrl?: string;
};

// Note: This list intentionally contains a curated set of popular assets.
// It can be extended at any time without touching the calling code.
const ASSET_METADATA: Record<string, AssetMetadata> = {
  IOTA: { symbol: "IOTA", name: "IOTA", explorerBaseUrl: "https://explorer.iota.org/txblock/" },
  BTC: { symbol: "BTC", name: "Bitcoin", explorerBaseUrl: "https://mempool.space/tx/" },
  ETH: { symbol: "ETH", name: "Ethereum", explorerBaseUrl: "https://etherscan.io/tx/" },
  USDT: { symbol: "USDT", name: "Tether", explorerBaseUrl: "https://etherscan.io/tx/" },
  USDC: { symbol: "USDC", name: "USD Coin", explorerBaseUrl: "https://etherscan.io/tx/" },
  BNB: { symbol: "BNB", name: "BNB", explorerBaseUrl: "https://bscscan.com/tx/" },
  XRP: { symbol: "XRP", name: "XRP", explorerBaseUrl: "https://livenet.xrpl.org/transactions/" },
  ADA: { symbol: "ADA", name: "Cardano", explorerBaseUrl: "https://cardanoscan.io/transaction/" },
  SOL: { symbol: "SOL", name: "Solana", explorerBaseUrl: "https://solscan.io/tx/" },
  DOGE: { symbol: "DOGE", name: "Dogecoin", explorerBaseUrl: "https://dogechain.info/tx/" },
  TRX: { symbol: "TRX", name: "TRON", explorerBaseUrl: "https://tronscan.org/#/transaction/" },
  DOT: { symbol: "DOT", name: "Polkadot", explorerBaseUrl: "https://polkascan.io/polkadot/transaction/" },
  MATIC: { symbol: "MATIC", name: "Polygon", explorerBaseUrl: "https://polygonscan.com/tx/" },
  LTC: { symbol: "LTC", name: "Litecoin", explorerBaseUrl: "https://blockchair.com/litecoin/transaction/" },
  SHIB: { symbol: "SHIB", name: "Shiba Inu", explorerBaseUrl: "https://etherscan.io/tx/" },
  AVAX: { symbol: "AVAX", name: "Avalanche", explorerBaseUrl: "https://snowtrace.io/tx/" },
  LINK: { symbol: "LINK", name: "Chainlink", explorerBaseUrl: "https://etherscan.io/tx/" },
  XLM: { symbol: "XLM", name: "Stellar", explorerBaseUrl: "https://stellarchain.io/tx/" },
  UNI: { symbol: "UNI", name: "Uniswap", explorerBaseUrl: "https://etherscan.io/tx/" },
  XMR: { symbol: "XMR", name: "Monero" },
  ETC: { symbol: "ETC", name: "Ethereum Classic", explorerBaseUrl: "https://etcblockexplorer.com/tx/" },
  BCH: { symbol: "BCH", name: "Bitcoin Cash", explorerBaseUrl: "https://blockchair.com/bitcoin-cash/transaction/" },
  ATOM: { symbol: "ATOM", name: "Cosmos Hub", explorerBaseUrl: "https://www.mintscan.io/cosmos/txs/" },
  OP: { symbol: "OP", name: "Optimism", explorerBaseUrl: "https://optimistic.etherscan.io/tx/" },
  ARB: { symbol: "ARB", name: "Arbitrum", explorerBaseUrl: "https://arbiscan.io/tx/" },
  AAVE: { symbol: "AAVE", name: "Aave", explorerBaseUrl: "https://etherscan.io/tx/" },
  SAND: { symbol: "SAND", name: "The Sandbox", explorerBaseUrl: "https://etherscan.io/tx/" },
  MANA: { symbol: "MANA", name: "Decentraland", explorerBaseUrl: "https://etherscan.io/tx/" },
  GRT: { symbol: "GRT", name: "The Graph", explorerBaseUrl: "https://etherscan.io/tx/" },
  RUNE: { symbol: "RUNE", name: "THORChain", explorerBaseUrl: "https://viewblock.io/thorchain/tx/" },
  STX: { symbol: "STX", name: "Stacks", explorerBaseUrl: "https://explorer.hiro.so/txid/" },
  INJ: { symbol: "INJ", name: "Injective", explorerBaseUrl: "https://www.mintscan.io/injective/txs/" },
  SUI: { symbol: "SUI", name: "Sui", explorerBaseUrl: "https://explorer.sui.io/tx/" },
  TON: { symbol: "TON", name: "Toncoin", explorerBaseUrl: "https://tonviewer.com/transaction/" },
  CRO: { symbol: "CRO", name: "Cronos", explorerBaseUrl: "https://cronoscan.com/tx/" },
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