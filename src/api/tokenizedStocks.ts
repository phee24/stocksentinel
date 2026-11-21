import { requireTsApiBaseUrl } from "../config.js";

/**
 * Client for the official Tokenized Stocks API on Base.
 * Public, read-only, no API key. Base URL (verified 2026-11-21 from the
 * official docs + live calls): https://api.coinbase.com/v1/tokenized-stocks
 *
 *   GET /                              list tokenized-stock records (paginated)
 *   GET /chains                        protocol contract addresses
 *   GET /total-supply/{contract}       normalized token supply (bare JSON number)
 *   GET /metadata/{ticker}             token metadata (ticker = API symbol, e.g. "NVDAc")
 *   GET /corporate-actions/{id}        one corporate action
 *   GET /prospectuses                  cached prospectuses
 *
 * The wire format is snake_case JSON and numeric fields are JSON numbers;
 * records omit default/empty values, so every field is treated as optional
 * and normalized into the camelCase shape below.
 */
export interface TokenizedStock {
  contractAddress: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  isin?: string;
  adgmIsin?: string;
  description?: string;
  /** Current scaling factor token units -> underlying shares (changes on splits/dividends). */
  multiplier?: number;
  totalSupply?: number;
  /** Most recent Chainlink-based NAV / reference value (per token). NOT a live bid/ask. */
  navPrice?: number;
  navPriceUpdatedAt?: string;
  firstMintDate?: string;
  pausedFeatures?: string[];
}

export interface CorporateAction {
  id: string;
  [key: string]: unknown;
}

interface RawStock {
  contract_address?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  isin?: string;
  adgm_isin?: string;
  description?: string;
  multiplier?: number;
  total_supply?: number;
  nav_price?: number;
  nav_price_updated_at?: string;
  first_mint_date?: string;
  paused_features?: string[];
  [key: string]: unknown;
}

interface ListResponse {
  tokens?: RawStock[];
  next_page_token?: string;
}

function normalize(raw: RawStock): TokenizedStock {
  return {
    contractAddress: raw.contract_address ?? "",
    symbol: raw.symbol,
    name: raw.name,
    decimals: raw.decimals,
    isin: raw.isin,
    adgmIsin: raw.adgm_isin,
    description: raw.description,
    multiplier: raw.multiplier,
    totalSupply: raw.total_supply,
    navPrice: raw.nav_price,
    navPriceUpdatedAt: raw.nav_price_updated_at,
    firstMintDate: raw.first_mint_date,
    pausedFeatures: raw.paused_features,
  };
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${requireTsApiBaseUrl()}${path}`);
  if (!res.ok) throw new Error(`Tokenized Stocks API ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Fetch the full token universe, following pagination to the end. */
export async function listAllStocks(pageSize = 500): Promise<TokenizedStock[]> {
  const out: TokenizedStock[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ page_size: String(pageSize) });
    if (pageToken) q.set("page_token", pageToken);
    const page = await getJson<ListResponse>(`?${q.toString()}`);
    out.push(...(page.tokens ?? []).map(normalize));
    pageToken = page.next_page_token;
  } while (pageToken);
  return out;
}

/** Underlying equity ticker for an API symbol ("NVDAc" -> "NVDA", "BRK.Bc" -> "BRK.B"). */
export function underlyingTicker(apiSymbol: string): string {
  return apiSymbol.endsWith("c") ? apiSymbol.slice(0, -1) : apiSymbol;
}

export async function getMetadata(ticker: string): Promise<TokenizedStock> {
  return normalize(await getJson<RawStock>(`/metadata/${encodeURIComponent(ticker)}`));
}

/** Normalized total supply (token units), as reported by the API. */
export async function getTotalSupply(contractAddress: string): Promise<number> {
  return getJson<number>(`/total-supply/${contractAddress}`);
}

export async function getCorporateAction(id: string): Promise<CorporateAction> {
  return getJson<CorporateAction>(`/corporate-actions/${encodeURIComponent(id)}`);
}

export async function getProtocolAddresses(): Promise<unknown> {
  return getJson(`/chains`);
}
