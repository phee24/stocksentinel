import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
import { config } from "../config.js";

export const baseClient = createPublicClient({
  chain: base,
  transport: http(config.baseRpcUrl),
});

const aggregatorAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

/**
 * Chainlink equity feeds on Base mainnet (proxy addresses from official Base docs,
 * "Integrate tokenized stocks" — List Tokenized Stocks). Values are TOTAL RETURN
 * (multiplier-adjusted), 8 decimals, market hours 24/5, frozen during corporate
 * actions. Verify against docs before relying on an address.
 */
export const CHAINLINK_FEEDS: Record<string, `0x${string}`> = {
  AAPL: "0x787f13dEa48Db0897CbCDD985de77809D837F988",
  AMZN: "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295",
  GOOGL: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2",
  META: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D",
  MSFT: "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c",
  MSTR: "0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a",
  NVDA: "0x04689a41629776563E6822F76f2e57D148d28513",
  SNDK: "0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA",
  SPCX: "0x6A634B235903C4ad6376892180d6fF8612e3Fa68",
  TSLA: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4",
};

export interface FeedReading {
  ticker: string;
  /** Total-return price, USD (answer / 1e8). */
  priceUsd: number;
  updatedAt: Date;
  /** True when the feed has not updated within the staleness bound (e.g. weekend or a corporate-action freeze). */
  stale: boolean;
}

export async function readFeed(ticker: string, staleHours: number): Promise<FeedReading | null> {
  const address = CHAINLINK_FEEDS[ticker];
  if (!address) return null;
  const [, answer, , updatedAt] = await baseClient.readContract({
    address,
    abi: aggregatorAbi,
    functionName: "latestRoundData",
  });
  const updated = new Date(Number(updatedAt) * 1000);
  return {
    ticker,
    priceUsd: Number(answer) / 1e8,
    updatedAt: updated,
    stale: Date.now() - updated.getTime() > staleHours * 3_600_000,
  };
}

/** Onchain Registry for B20 tokenized stocks (official docs). */
export const ONCHAIN_REGISTRY = "0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD" as const;

/** Chainlink ETH/USD feed on Base mainnet (8 decimals). Verified live 2026-11-21. */
export const ETH_USD_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" as const;

export async function readEthUsd(): Promise<number> {
  const [, answer] = await baseClient.readContract({
    address: ETH_USD_FEED,
    abi: aggregatorAbi,
    functionName: "latestRoundData",
  });
  return Number(answer) / 1e8;
}

const erc20Abi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

/** Onchain ERC-20 total supply in human units (cross-check for the API figure). */
export async function readTotalSupply(tokenAddress: string, decimals: number): Promise<number> {
  const raw = await baseClient.readContract({
    address: tokenAddress as `0x${string}`,
    abi: erc20Abi,
    functionName: "totalSupply",
  });
  return Number(raw) / 10 ** decimals;
}

export { erc20Abi };
