import type { DislocationSignal } from "../engine/dislocation.js";
import type { CorporateActionSignal } from "../engine/corporateActions.js";
import type { Snapshot } from "../store.js";

export interface SignalFeed {
  generatedAt: string;
  agent: "StockSentinel";
  network: "base-mainnet (data) + base-sepolia (anchors)";
  coverage: {
    tokensInUniverse: number;
    tickersMonitored: number;
    withDexPrice: number;
    withNav: number;
  };
  dislocations: DislocationSignal[];
  corporateActions: CorporateActionSignal[];
}

/** Machine-readable public signal feed (build D5). */
export function buildSignalFeed(
  dislocations: DislocationSignal[],
  corporateActions: CorporateActionSignal[],
  coverage: SignalFeed["coverage"] = {
    tokensInUniverse: 0,
    tickersMonitored: 0,
    withDexPrice: 0,
    withNav: 0,
  },
): SignalFeed {
  return {
    generatedAt: new Date().toISOString(),
    agent: "StockSentinel",
    network: "base-mainnet (data) + base-sepolia (anchors)",
    coverage,
    dislocations,
    corporateActions,
  };
}

function fmtUsd(x: number | null): string {
  return x == null ? "n/a" : `$${x.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function fmtPct(x: number | null): string {
  return x == null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
}

/** Human daily brief in Markdown (build D5). */
export function buildDailyBrief(feed: SignalFeed, snapshot?: Snapshot): string {
  const lines: string[] = [
    `# StockSentinel daily brief — ${feed.generatedAt.slice(0, 10)}`,
    "",
    `Universe: ${feed.coverage.tokensInUniverse} tokenized stocks · monitored: ${feed.coverage.tickersMonitored} tickers (${feed.coverage.withDexPrice} with a DEX price)`,
    `Dislocation signals: ${feed.dislocations.length} · Corporate-action signals: ${feed.corporateActions.length}`,
    "",
  ];
  if (feed.dislocations.length > 0) {
    lines.push("## Dislocations (DEX vs NAV)", "");
    for (const d of feed.dislocations) {
      lines.push(
        `- **${d.ticker}** DEX ${d.direction} ${d.pct.toFixed(2)}% vs NAV ` +
          `(DEX $${d.dexUsd.toFixed(2)} · NAV $${d.navUsd.toFixed(2)}${d.navStale ? " · NAV stale/frozen" : ""})`,
      );
    }
    lines.push("");
  }
  if (feed.corporateActions.length > 0) {
    lines.push("## Corporate actions & market state", "");
    for (const c of feed.corporateActions) {
      lines.push(`- **${c.ticker}** ${c.kind}: ${c.detail}${c.effectiveAt ? ` (effective ${c.effectiveAt})` : ""}`);
    }
    lines.push("");
  }
  if (snapshot) {
    lines.push("## Monitored tickers (latest snapshot)", "");
    lines.push("| Ticker | NAV | DEX | Δ DEX vs NAV | Supply (tokens) | Multiplier | Pool depth |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const t of Object.values(snapshot.tickers)) {
      lines.push(
        `| ${t.ticker} | ${fmtUsd(t.navUsd)}${t.navStale ? " (stale)" : ""} | ${fmtUsd(t.dexUsd)} | ${fmtPct(t.dislocationPct)} | ` +
          `${t.totalSupply == null ? "n/a" : t.totalSupply.toLocaleString("en-US", { maximumFractionDigits: 2 })} | ` +
          `${t.multiplier == null ? "n/a" : t.multiplier} | ${fmtUsd(t.poolDepthUsd)} |`,
      );
    }
    lines.push("");
  }
  lines.push("_Research/monitoring only. Not financial advice. No trading is executed._");
  return lines.join("\n");
}

// TODO(build D6): static dashboard renderer (HTML) regenerated every cycle.
