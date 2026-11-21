import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createPublicClient, http, parseAbiItem, type Log } from "viem";
import { base } from "viem/chains";
import { config } from "../config.js";
import type { CorporateActionSignal } from "../engine/corporateActions.js";

/**
 * Onchain ERC-8056 / B20 event radar (build D4).
 *
 * B20 Asset tokens are Base-native precompiles; their corporate-action
 * surface emits (signatures verified against the official Base docs +
 * CDP B20 event index, and against live mainnet logs 2026-11-21):
 *
 *   UIMultiplierUpdated(uint256 old, uint256 new, uint256 effectiveAt)
 *     — fired when a multiplier update is RECORDED (scheduled), not when it
 *       matures. effectiveAt > block time = advance notice of a split /
 *       dividend adjustment. (SNDK's 1 -> 8 split was caught this way:
 *       block 59674150, effective 2026-11-20T05:00Z.)
 *   UIMultiplierUpdateCancelled(uint256 cancelled, uint256 cancelledEffectiveAt)
 *   Announcement(address indexed caller, string id, string description, string uri)
 *     — disclosure bracket opened by `announce(...)`; EndAnnouncement(string)
 *       closes it (not signalled separately).
 *
 * Multipliers onchain are WAD (1e18 = 1.0); the API/snapshot side uses plain
 * floats, so conversions happen here.
 *
 * The scanner is incremental: it persists { lastScannedBlock, seen[] } in
 * data/radar-state.json and only walks new blocks on later cycles. The first
 * run backfills config.radarBackfillBlocks. Public RPCs rate-limit
 * eth_getLogs, so scanning uses a dedicated RPC (default publicnode), small
 * chunks, per-event calls, and retry-with-backoff.
 */

export const b20Events = [
  parseAbiItem(
    "event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp)",
  ),
  parseAbiItem("event UIMultiplierUpdateCancelled(uint256 cancelledMultiplier, uint256 cancelledEffectiveAt)"),
  parseAbiItem("event Announcement(address indexed caller, string id, string description, string uri)"),
] as const;

export const radarClient = createPublicClient({
  chain: base,
  transport: http(config.radarRpcUrl),
});

export interface RadarState {
  lastScannedBlock: string; // decimal string (bigint-safe)
  seen: string[]; // `${txHash}:${logIndex}` of logs already turned into signals
  updatedAt: string;
}

const SEEN_CAP = 1000;

export async function loadRadarState(dataDir: string): Promise<RadarState | null> {
  try {
    return JSON.parse(await readFile(join(dataDir, "radar-state.json"), "utf8")) as RadarState;
  } catch {
    return null;
  }
}

async function saveRadarState(dataDir: string, state: RadarState): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "radar-state.json"), JSON.stringify(state, null, 2));
}

export function wadToMultiplier(wad: bigint): number {
  return Number(wad) / 1e18;
}

function fmtMult(x: number): string {
  return Number(x.toPrecision(6)).toString();
}

type DecodedLog = Log & {
  eventName?: string;
  args?: Record<string, unknown>;
};

/** Pure conversion: one decoded B20 log -> signal (or null). Exported for tests. */
export function logToSignal(
  ticker: string,
  eventName: string,
  args: Record<string, unknown>,
  blockTimestamp: Date,
  txHash: string,
): CorporateActionSignal | null {
  const at = blockTimestamp.toISOString();
  if (eventName === "UIMultiplierUpdated") {
    const oldM = wadToMultiplier(args.oldMultiplier as bigint);
    const newM = wadToMultiplier(args.newMultiplier as bigint);
    const effectiveAtSec = Number(args.effectiveAtTimestamp as bigint);
    const effectiveAt = new Date(effectiveAtSec * 1000);
    const scheduled = effectiveAtSec > Math.floor(blockTimestamp.getTime() / 1000);
    return {
      ticker,
      kind: scheduled ? "multiplier_scheduled" : "multiplier_applied",
      detail:
        `multiplier ${fmtMult(oldM)} -> ${fmtMult(newM)} recorded onchain (ERC-8056)` +
        (scheduled ? `, effective ${effectiveAt.toISOString()}` : ", effective immediately") +
        ` · tx ${txHash.slice(0, 10)}…`,
      effectiveAt: effectiveAt.toISOString(),
      at,
    };
  }
  if (eventName === "UIMultiplierUpdateCancelled") {
    const cancelled = wadToMultiplier(args.cancelledMultiplier as bigint);
    const cancelledAt = new Date(Number(args.cancelledEffectiveAt as bigint) * 1000);
    return {
      ticker,
      kind: "multiplier_cancelled",
      detail: `scheduled multiplier ${fmtMult(cancelled)} (effective ${cancelledAt.toISOString()}) was cancelled onchain · tx ${txHash.slice(0, 10)}…`,
      at,
    };
  }
  if (eventName === "Announcement") {
    const description = String(args.description ?? "").slice(0, 280);
    const id = String(args.id ?? "");
    const uri = String(args.uri ?? "");
    return {
      ticker,
      kind: "announcement",
      detail:
        `issuer announcement onchain: "${description}" (id ${id})` +
        (uri ? ` · ${uri}` : "") +
        ` · tx ${txHash.slice(0, 10)}…`,
      at,
    };
  }
  return null;
}

export interface PendingMultiplier {
  uiMultiplier: number;
  newMultiplier: number;
  effectiveAt: Date;
  /** True when a schedule is live: effectiveAt in the future and value differs. */
  live: boolean;
}

const pendingAbi = [
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "newUIMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "effectiveAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

/**
 * Read the pending-multiplier state directly from the token. This catches a
 * live schedule even if the log scan has not reached its block yet, and it
 * keeps working if logs are pruned: per Base docs, a schedule is live iff
 * effectiveAt() > block.timestamp (never test effectiveAt == 0).
 */
export async function readPendingMultiplier(address: string): Promise<PendingMultiplier | null> {
  try {
    const [ui, next, eff] = await Promise.all([
      radarClient.readContract({ address: address as `0x${string}`, abi: pendingAbi, functionName: "uiMultiplier" }),
      radarClient.readContract({ address: address as `0x${string}`, abi: pendingAbi, functionName: "newUIMultiplier" }),
      radarClient.readContract({ address: address as `0x${string}`, abi: pendingAbi, functionName: "effectiveAt" }),
    ]);
    const effectiveAt = new Date(Number(eff) * 1000);
    const uiMultiplier = wadToMultiplier(ui);
    const newMultiplier = wadToMultiplier(next);
    return {
      uiMultiplier,
      newMultiplier,
      effectiveAt,
      live: Number(eff) > Math.floor(Date.now() / 1000) && newMultiplier !== uiMultiplier,
    };
  } catch {
    return null;
  }
}

/** Pure: turn a live pending reading into a scheduled-multiplier signal. */
export function pendingToSignal(
  ticker: string,
  pending: PendingMultiplier,
  at: Date = new Date(),
): CorporateActionSignal | null {
  if (!pending.live) return null;
  return {
    ticker,
    kind: "multiplier_scheduled",
    detail: `multiplier ${fmtMult(pending.uiMultiplier)} -> ${fmtMult(pending.newMultiplier)} scheduled onchain (ERC-8056 pending state), effective ${pending.effectiveAt.toISOString()}`,
    effectiveAt: pending.effectiveAt.toISOString(),
    at: at.toISOString(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getLogsChunk(
  addresses: `0x${string}`[],
  event: (typeof b20Events)[number],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<DecodedLog[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return (await radarClient.getLogs({
        address: addresses,
        event,
        fromBlock,
        toBlock,
      })) as DecodedLog[];
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(800 * (attempt + 1));
    }
  }
  return [];
}

export interface RadarScanResult {
  signals: CorporateActionSignal[];
  fromBlock: bigint;
  toBlock: bigint;
  logsSeen: number;
}

/**
 * Incremental scan of B20 corporate-action events for the given tokens.
 * Persists progress in data/radar-state.json; dedupes by txHash:logIndex and
 * by the pending-state key namespace shared with the cycle.
 */
export async function scanB20Events(
  dataDir: string,
  tokens: { ticker: string; address: string }[],
  seenExtra: Set<string> = new Set(),
): Promise<RadarScanResult> {
  const targets = tokens.filter((t) => t.address);
  const byAddress = new Map(targets.map((t) => [t.address.toLowerCase(), t.ticker]));
  const addresses = targets.map((t) => t.address as `0x${string}`);

  const latest = await radarClient.getBlockNumber();
  const state = await loadRadarState(dataDir);
  let fromBlock: bigint;
  if (state) {
    fromBlock = BigInt(state.lastScannedBlock) + 1n;
    // If the state fell far behind (long downtime), don't replay forever:
    // jump to the configured backfill window.
    const floor = latest - BigInt(config.radarBackfillBlocks) * 4n;
    if (fromBlock < floor) fromBlock = floor;
  } else {
    fromBlock = latest - BigInt(config.radarBackfillBlocks);
  }
  if (fromBlock < 0n) fromBlock = 0n;

  const seen = new Set<string>([...(state?.seen ?? []), ...seenExtra]);
  const signals: CorporateActionSignal[] = [];
  let logsSeen = 0;
  const blockTimes = new Map<bigint, Date>();

  if (addresses.length > 0 && fromBlock <= latest) {
    const chunk = BigInt(config.radarChunkBlocks);
    for (let from = fromBlock; from <= latest; from += chunk) {
      const to = from + chunk - 1n > latest ? latest : from + chunk - 1n;
      for (const event of b20Events) {
        const logs = await getLogsChunk(addresses, event, from, to);
        for (const log of logs) {
          logsSeen++;
          const key = `${log.transactionHash}:${log.logIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const ticker = byAddress.get((log.address as string).toLowerCase());
          if (!ticker || !log.eventName || !log.args || log.blockNumber == null) continue;
          if (!blockTimes.has(log.blockNumber)) {
            const block = await radarClient.getBlock({ blockNumber: log.blockNumber });
            blockTimes.set(log.blockNumber, new Date(Number(block.timestamp) * 1000));
          }
          const signal = logToSignal(
            ticker,
            log.eventName,
            log.args as Record<string, unknown>,
            blockTimes.get(log.blockNumber)!,
            log.transactionHash as string,
          );
          if (signal) signals.push(signal);
        }
        await sleep(100);
      }
    }
  }

  const seenArr = [...seen].slice(-SEEN_CAP);
  await saveRadarState(dataDir, {
    lastScannedBlock: latest.toString(),
    seen: seenArr,
    updatedAt: new Date().toISOString(),
  });

  return { signals, fromBlock, toBlock: latest, logsSeen };
}
