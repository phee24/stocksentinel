import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** One monitored ticker's state at one cycle. Nulls mean "source unavailable". */
export interface TickerSnapshot {
  ticker: string; // underlying equity ticker, e.g. "NVDA"
  symbol: string; // API symbol, e.g. "NVDAc"
  address: string;
  navUsd: number | null; // Chainlink total-return NAV (onchain feed; API fallback)
  navUpdatedAt: string | null; // ISO
  navStale: boolean;
  dexUsd: number | null;
  poolAddress: string | null;
  poolType: string | null;
  poolDepthUsd: number | null;
  dislocationPct: number | null; // signed, (dex-nav)/nav*100, regardless of alert threshold
  multiplier: number | null;
  totalSupply: number | null; // token units (onchain; API fallback)
}

export interface Snapshot {
  at: string; // ISO timestamp of the cycle
  tickers: Record<string, TickerSnapshot>;
}

function stamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export async function saveSnapshot(dataDir: string, snapshot: Snapshot): Promise<string> {
  const dir = join(dataDir, "snapshots");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `snapshot-${stamp()}.json`);
  const body = JSON.stringify(snapshot, null, 2);
  await writeFile(file, body);
  await writeFile(join(dataDir, "latest.json"), body);
  return file;
}

/** Previous cycle's snapshot (data/latest.json), or null on first run. */
export async function loadLatest(dataDir: string): Promise<Snapshot | null> {
  try {
    return JSON.parse(await readFile(join(dataDir, "latest.json"), "utf8")) as Snapshot;
  } catch {
    return null;
  }
}
