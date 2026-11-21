import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Snapshot } from "../store.js";
import type { SignalFeed } from "./brief.js";

/**
 * Per-token report (build D8): one command -> one Markdown report for a
 * single ticker, assembled from the snapshot time series in data/snapshots/
 * plus the latest signal feed. Run: `npm run token -- NVDA`.
 */

/** All persisted snapshots, oldest -> newest. */
export async function loadSnapshotHistory(dataDir: string): Promise<Snapshot[]> {
  const dir = join(dataDir, "snapshots");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: Snapshot[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(await readFile(join(dir, f), "utf8")) as Snapshot);
    } catch {
      // skip a torn write
    }
  }
  return out;
}

function fmtUsd(x: number | null | undefined): string {
  return x == null ? "n/a" : `$${x.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function fmtPct(x: number | null | undefined): string {
  return x == null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
}

export function buildTokenReport(
  ticker: string,
  history: Snapshot[],
  feed: SignalFeed | null,
  thresholdPct = 2,
): string {
  const key = ticker.toUpperCase();
  const series = history
    .map((s) => ({ at: s.at, t: s.tickers[key] }))
    .filter((x) => x.t);
  const lines: string[] = [`# StockSentinel report — ${key}`, ""];

  if (series.length === 0) {
    lines.push(`No snapshots recorded for ${key} yet. Run a monitoring cycle first (npm run once).`);
    return lines.join("\n");
  }

  const latest = series[series.length - 1].t!;
  lines.push(
    `Generated from ${series.length} snapshot(s), ${series[0].at} -> ${series[series.length - 1].at}.`,
    "",
    "## Current state",
    "",
    `- Token: ${latest.symbol} (${latest.address})`,
    `- NAV (Chainlink): ${fmtUsd(latest.navUsd)}${latest.navStale ? " — STALE/frozen" : ""} (updated ${latest.navUpdatedAt ?? "unknown"})`,
    `- DEX price (Aerodrome): ${fmtUsd(latest.dexUsd)}${latest.poolAddress ? ` via ${latest.poolType ?? "pool"} ${latest.poolAddress}` : ""}`,
    `- Pool depth (approx): ${fmtUsd(latest.poolDepthUsd)}`,
    `- Dislocation: ${fmtPct(latest.dislocationPct)} vs NAV`,
    `- Multiplier: ${latest.multiplier ?? "n/a"}`,
    `- Total supply: ${latest.totalSupply == null ? "n/a" : latest.totalSupply.toLocaleString("en-US", { maximumFractionDigits: 2 })} tokens`,
    "",
  );

  const discs = series.map((x) => x.t!.dislocationPct).filter((x): x is number => x != null);
  if (discs.length > 0) {
    const over = series.filter(
      (x) => x.t!.dislocationPct != null && Math.abs(x.t!.dislocationPct) >= thresholdPct,
    ).length;
    lines.push(
      "## Dislocation history",
      "",
      `- Observations: ${discs.length} · min ${fmtPct(Math.min(...discs))} · max ${fmtPct(Math.max(...discs))} · latest ${fmtPct(discs[discs.length - 1])}`,
      `- Cycles at/over the ±${thresholdPct}% signal threshold: ${over}`,
      "",
    );
  }

  const mults = series
    .map((x) => ({ at: x.at, m: x.t!.multiplier }))
    .filter((x) => x.m != null);
  if (mults.length > 1) {
    const changes: string[] = [];
    for (let i = 1; i < mults.length; i++) {
      if (mults[i].m !== mults[i - 1].m) {
        changes.push(`- ${mults[i].at}: multiplier ${mults[i - 1].m} -> ${mults[i].m}`);
      }
    }
    lines.push("## Multiplier history", "");
    if (changes.length > 0) lines.push(...changes);
    else lines.push(`- Unchanged across history (current ${mults[mults.length - 1].m}).`);
    lines.push("");
  }

  if (feed) {
    const mine = [
      ...feed.dislocations
        .filter((d) => d.ticker === key)
        .map((d) => `- ${d.at}: dislocation ${d.direction} ${d.pct.toFixed(2)}% (DEX $${d.dexUsd.toFixed(2)} vs NAV $${d.navUsd.toFixed(2)})`),
      ...feed.corporateActions
        .filter((c) => c.ticker === key)
        .map((c) => `- ${c.at}: ${c.kind} — ${c.detail}${c.effectiveAt ? ` (effective ${c.effectiveAt})` : ""}`),
    ];
    lines.push("## Signals in latest feed", "");
    if (mine.length > 0) lines.push(...mine);
    else lines.push("- None in the latest cycle.");
    lines.push("");
  }

  lines.push("## Recent snapshots", "");
  lines.push("| At (UTC) | NAV | DEX | Δ % | Supply | Multiplier |");
  lines.push("|---|---|---|---|---|---|");
  for (const x of series.slice(-10).reverse()) {
    const t = x.t!;
    lines.push(
      `| ${x.at.replace("T", " ").slice(0, 16)} | ${fmtUsd(t.navUsd)}${t.navStale ? " (stale)" : ""} | ${fmtUsd(t.dexUsd)} | ${fmtPct(t.dislocationPct)} | ${t.totalSupply == null ? "n/a" : t.totalSupply.toLocaleString("en-US", { maximumFractionDigits: 0 })} | ${t.multiplier ?? "n/a"} |`,
    );
  }
  lines.push("", "_Research/monitoring only. Not financial advice._");
  return lines.join("\n");
}
