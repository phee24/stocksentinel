import { readFileSync } from "node:fs";

// Minimal .env loader (no dependency): fills process.env from ./.env when a
// variable is not already set in the real environment.
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  // No .env file — rely on real environment + defaults below.
}

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  // Tokenized Stocks API (public, read-only, no key). Base URL verified
  // 2026-11-21 from the official docs (overview cURL example) and live calls:
  // https://docs.base.org/sdks/tokenized-stocks/overview
  tsApiBaseUrl: env("TS_API_BASE_URL", "https://api.coinbase.com/v1/tokenized-stocks").replace(/\/$/, ""),

  baseRpcUrl: env("BASE_RPC_URL", "https://mainnet.base.org"),
  baseSepoliaRpcUrl: env("BASE_SEPOLIA_RPC_URL", "https://sepolia.base.org"),

  // ERC-8056 event radar (D4). eth_getLogs is heavily rate-limited on the
  // default RPC; publicnode tolerates chunked historical scans.
  radarRpcUrl: env("RADAR_RPC_URL", "https://base-rpc.publicnode.com"),
  radarBackfillBlocks: envNum("RADAR_BACKFILL_BLOCKS", 300_000),
  radarChunkBlocks: envNum("RADAR_CHUNK_BLOCKS", 5_000),

  pollIntervalMs: envNum("POLL_INTERVAL_MS", 600_000),
  dislocationAlertPct: envNum("DISLOCATION_ALERT_PCT", 2.0),
  navStaleHours: envNum("NAV_STALE_HOURS", 30),

  anchorPrivateKey: env("ANCHOR_PRIVATE_KEY"),
  signalLogAddress: env("SIGNAL_LOG_ADDRESS"),
  builderCode: env("BUILDER_CODE"), // optional ERC-8021 attribution suffix (hex)

  dataDir: env("DATA_DIR", "data"),
} as const;

export function requireTsApiBaseUrl(): string {
  if (!config.tsApiBaseUrl) {
    throw new Error(
      "TS_API_BASE_URL is not set. Confirm the base URL from the Tokenized Stocks API " +
        "reference (https://docs.base.org/sdks/tokenized-stocks/overview) and set it in .env.",
    );
  }
  return config.tsApiBaseUrl;
}
