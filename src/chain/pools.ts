import { parseAbi, type Address } from "viem";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { baseClient, erc20Abi } from "./feeds.js";
import { config } from "../config.js";

/**
 * DEX price discovery for B20 tokenized stocks (Aerodrome on Base).
 *
 * Verified live on Base mainnet, 2026-11-21:
 *  - Classic (volatile/stable) PoolFactory: 0x420DD381b31aEf6683db6B902084cB0FFECe40Da
 *    (its NVDAc/USDC volatile pool exists but is dust — real liquidity is CL.)
 *  - Slipstream CL factory: 0x9CB220581b91b0C83223012FE69688b92aD07a76
 *    (read from a live pool's factory(); getPool uses int24 tickSpacing.)
 * Prices are always computed from onchain state (reserves / slot0), never
 * from an aggregator. Pool discovery results are cached in the data dir;
 * the cached pool's price is re-read fresh every cycle.
 */
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const WETH = "0x4200000000000000000000000000000000000006" as const;
const CLASSIC_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as const;
const CL_FACTORY = "0x9CB220581b91b0C83223012FE69688b92aD07a76" as const;
const CL_TICK_SPACINGS = [1, 10, 50, 100, 200, 2000];
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const classicFactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, bool stable) view returns (address)",
]);
const clFactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)",
]);
const classicPoolAbi = parseAbi([
  "function getReserves() view returns (uint256 _reserve0, uint256 _reserve1, uint256 _blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const clPoolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

export type PoolType = "aerodrome-classic" | "aerodrome-cl";

export interface DexQuote {
  ticker: string;
  poolAddress: string;
  poolType: PoolType;
  quoteSymbol: "USDC" | "WETH";
  priceUsd: number;
  /** Total USD value of both token balances held by the pool (depth proxy). */
  reserveUsdApprox: number;
}

/** Human-units quote-per-stock price from classic pool reserves. Pure — unit-tested. */
export function priceFromReserves(
  reserveStockRaw: bigint,
  stockDecimals: number,
  reserveQuoteRaw: bigint,
  quoteDecimals: number,
): number {
  const stock = Number(reserveStockRaw) / 10 ** stockDecimals;
  const quote = Number(reserveQuoteRaw) / 10 ** quoteDecimals;
  if (!(stock > 0)) return 0;
  return quote / stock;
}

/**
 * Human-units price of token0 denominated in token1 from a CL sqrtPriceX96.
 * raw ratio = (sqrtPrice / 2^96)^2 is token1-raw per token0-raw; the decimal
 * adjustment converts to human units. Pure — unit-tested.
 */
export function priceFromSqrtPriceX96(
  sqrtPriceX96: bigint,
  token0Decimals: number,
  token1Decimals: number,
): number {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  return ratio * ratio * 10 ** (token0Decimals - token1Decimals);
}

interface PoolRef {
  address: Address;
  type: PoolType;
  quote: Address;
  quoteSymbol: "USDC" | "WETH";
  quoteDecimals: number;
  quoteUsd: number; // USD per quote unit (1 for USDC, ETH/USD for WETH)
}

interface QuoteContext {
  stockDecimals: number;
  navUsd: number | null;
  ethUsd: number | null;
}

async function readOr<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

async function discoverPools(stock: Address, ctx: QuoteContext): Promise<PoolRef[]> {
  const quotes: { address: Address; symbol: "USDC" | "WETH"; decimals: number; usd: number }[] = [
    { address: USDC, symbol: "USDC", decimals: 6, usd: 1 },
    ...(ctx.ethUsd && ctx.ethUsd > 0
      ? [{ address: WETH, symbol: "WETH" as const, decimals: 18, usd: ctx.ethUsd }]
      : []),
  ];
  const probes: Promise<PoolRef | null>[] = [];
  for (const q of quotes) {
    for (const stable of [false, true]) {
      probes.push(
        readOr(
          baseClient.readContract({
            address: CLASSIC_FACTORY,
            abi: classicFactoryAbi,
            functionName: "getPool",
            args: [stock, q.address, stable],
          }),
          ZERO_ADDRESS as Address,
        ).then((pool) =>
          pool === ZERO_ADDRESS
            ? null
            : { address: pool, type: "aerodrome-classic" as const, quote: q.address, quoteSymbol: q.symbol, quoteDecimals: q.decimals, quoteUsd: q.usd },
        ),
      );
    }
    for (const ts of CL_TICK_SPACINGS) {
      probes.push(
        readOr(
          baseClient.readContract({
            address: CL_FACTORY,
            abi: clFactoryAbi,
            functionName: "getPool",
            args: [stock, q.address, ts],
          }),
          ZERO_ADDRESS as Address,
        ).then((pool) =>
          pool === ZERO_ADDRESS
            ? null
            : { address: pool, type: "aerodrome-cl" as const, quote: q.address, quoteSymbol: q.symbol, quoteDecimals: q.decimals, quoteUsd: q.usd },
        ),
      );
    }
  }
  const found = await Promise.all(probes);
  const seen = new Set<string>();
  return found.filter((r): r is PoolRef => {
    if (!r || seen.has(r.address.toLowerCase())) return false;
    seen.add(r.address.toLowerCase());
    return true;
  });
}

async function evaluatePool(
  ticker: string,
  ref: PoolRef,
  stock: Address,
  ctx: QuoteContext,
): Promise<DexQuote | null> {
  const pool = ref.address;
  const abi = ref.type === "aerodrome-classic" ? classicPoolAbi : clPoolAbi;
  const [token0, token1, stockBalRaw, quoteBalRaw] = await Promise.all([
    readOr(baseClient.readContract({ address: pool, abi, functionName: "token0" }), null),
    readOr(baseClient.readContract({ address: pool, abi, functionName: "token1" }), null),
    readOr(baseClient.readContract({ address: stock, abi: erc20Abi, functionName: "balanceOf", args: [pool] }), 0n),
    readOr(baseClient.readContract({ address: ref.quote, abi: erc20Abi, functionName: "balanceOf", args: [pool] }), 0n),
  ]);
  if (!token0 || !token1) return null;
  const stockIsToken0 = token0.toLowerCase() === stock.toLowerCase();
  const stockDecimals = ctx.stockDecimals;
  const token0Decimals = stockIsToken0 ? stockDecimals : ref.quoteDecimals;
  const token1Decimals = stockIsToken0 ? ref.quoteDecimals : stockDecimals;

  let quotePerStock: number;
  if (ref.type === "aerodrome-classic") {
    const reserves = await readOr(
      baseClient.readContract({ address: pool, abi: classicPoolAbi, functionName: "getReserves" }),
      null,
    );
    if (!reserves) return null;
    const [r0, r1] = reserves;
    quotePerStock = stockIsToken0
      ? priceFromReserves(r0, stockDecimals, r1, ref.quoteDecimals)
      : priceFromReserves(r1, stockDecimals, r0, ref.quoteDecimals);
  } else {
    const slot0 = await readOr(
      baseClient.readContract({ address: pool, abi: clPoolAbi, functionName: "slot0" }),
      null,
    );
    if (!slot0) return null;
    const priceToken0InToken1 = priceFromSqrtPriceX96(slot0[0], token0Decimals, token1Decimals);
    quotePerStock = stockIsToken0 ? priceToken0InToken1 : 1 / priceToken0InToken1;
  }
  if (!Number.isFinite(quotePerStock) || quotePerStock <= 0) return null;

  const priceUsd = quotePerStock * ref.quoteUsd;
  const stockBalUsd = (Number(stockBalRaw) / 10 ** stockDecimals) * (ctx.navUsd ?? priceUsd);
  const quoteBalUsd = (Number(quoteBalRaw) / 10 ** ref.quoteDecimals) * ref.quoteUsd;
  const reserveUsdApprox = stockBalUsd + quoteBalUsd;
  if (!(reserveUsdApprox > 0)) return null;

  return {
    ticker,
    poolAddress: pool,
    poolType: ref.type,
    quoteSymbol: ref.quoteSymbol,
    priceUsd,
    reserveUsdApprox,
  };
}

// --- Pool discovery cache (data dir) ---------------------------------------

interface PoolCacheEntry {
  poolAddress: string;
  poolType: PoolType;
  quoteSymbol: "USDC" | "WETH";
  discoveredAt: string;
}

async function loadPoolCache(): Promise<Record<string, PoolCacheEntry>> {
  try {
    return JSON.parse(await readFile(join(config.dataDir, "pool-cache.json"), "utf8")) as Record<
      string,
      PoolCacheEntry
    >;
  } catch {
    return {};
  }
}

async function savePoolCache(cache: Record<string, PoolCacheEntry>): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(join(config.dataDir, "pool-cache.json"), JSON.stringify(cache, null, 2));
}

/**
 * Best DEX quote for a tokenized stock: deepest Aerodrome pool (classic or
 * Slipstream CL) against USDC/WETH, priced from onchain state. Returns null
 * when no usable pool exists — callers then fall back to NAV-only monitoring.
 */
export async function getDexQuote(
  ticker: string,
  tokenAddress: string,
  ctx: QuoteContext,
): Promise<DexQuote | null> {
  const stock = tokenAddress as Address;
  const cache = await loadPoolCache();
  const cached = cache[tokenAddress.toLowerCase()];
  if (cached) {
    const ref: PoolRef = {
      address: cached.poolAddress as Address,
      type: cached.poolType,
      quote: cached.quoteSymbol === "USDC" ? USDC : WETH,
      quoteSymbol: cached.quoteSymbol,
      quoteDecimals: cached.quoteSymbol === "USDC" ? 6 : 18,
      quoteUsd: cached.quoteSymbol === "USDC" ? 1 : (ctx.ethUsd ?? 0),
    };
    if (ref.quoteUsd > 0) {
      const quote = await evaluatePool(ticker, ref, stock, ctx);
      if (quote) return quote;
    }
    // Cached pool went dry / unreadable — fall through to rediscovery.
  }

  const refs = await discoverPools(stock, ctx);
  let best: DexQuote | null = null;
  for (const ref of refs) {
    const quote = await evaluatePool(ticker, ref, stock, ctx).catch(() => null);
    if (quote && (!best || quote.reserveUsdApprox > best.reserveUsdApprox)) best = quote;
  }
  if (best) {
    cache[tokenAddress.toLowerCase()] = {
      poolAddress: best.poolAddress,
      poolType: best.poolType,
      quoteSymbol: best.quoteSymbol,
      discoveredAt: new Date().toISOString(),
    };
    await savePoolCache(cache);
  }
  return best;
}
