import type { SignalFeed } from "./brief.js";
import type { Snapshot, TickerSnapshot } from "../store.js";

/**
 * Static dashboard renderer (build D6). Regenerated every cycle from the
 * latest snapshot + signal feed; a single self-contained HTML file (inline
 * CSS, no external assets) so it can be opened locally or dropped on
 * GitHub Pages as-is.
 */

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmtUsd(x: number | null): string {
  return x == null ? "n/a" : `$${x.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function fmtPct(x: number | null): string {
  return x == null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
}

function fmtSupply(x: number | null): string {
  return x == null ? "n/a" : x.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function dislocationClass(t: TickerSnapshot): string {
  if (t.dislocationPct == null) return "";
  const a = Math.abs(t.dislocationPct);
  if (a >= 5) return "disc-high";
  if (a >= 2) return "disc-mid";
  return "";
}

function tickerRow(t: TickerSnapshot): string {
  const stale = t.navStale
    ? ' <span class="badge stale">NAV stale</span>'
    : "";
  const disc =
    t.dislocationPct == null
      ? "n/a"
      : `${fmtPct(t.dislocationPct)}${Math.abs(t.dislocationPct) >= 2 ? ' <span class="badge disc">signal</span>' : ""}`;
  return (
    `<tr class="${dislocationClass(t)}">` +
    `<td><strong>${escapeHtml(t.ticker)}</strong> <span class="muted">${escapeHtml(t.symbol)}</span></td>` +
    `<td>${fmtUsd(t.dexUsd)}</td>` +
    `<td>${fmtUsd(t.navUsd)}${stale}<br><span class="muted small">${t.navUpdatedAt ? escapeHtml(t.navUpdatedAt.replace("T", " ").slice(0, 16)) + " UTC" : ""}</span></td>` +
    `<td>${disc}</td>` +
    `<td>${fmtSupply(t.totalSupply)}</td>` +
    `<td>${t.multiplier == null ? "n/a" : t.multiplier}</td>` +
    `<td>${fmtUsd(t.poolDepthUsd)}<br><span class="muted small">${t.poolType ? escapeHtml(t.poolType) : ""}</span></td>` +
    `</tr>`
  );
}

export interface DashboardOptions {
  anchorInfo?: string; // e.g. "SignalLog 0x… · last anchor tx 0x…"
}

export function buildDashboard(snapshot: Snapshot, feed: SignalFeed, opts: DashboardOptions = {}): string {
  const tickers = Object.values(snapshot.tickers).sort(
    (a, b) => Math.abs(b.dislocationPct ?? 0) - Math.abs(a.dislocationPct ?? 0),
  );
  const signals = [
    ...feed.dislocations.map((d) => ({
      at: d.at,
      html: `<strong>${escapeHtml(d.ticker)}</strong> dislocation — DEX ${escapeHtml(d.direction)} ${d.pct.toFixed(2)}% vs NAV (DEX $${d.dexUsd.toFixed(2)} · NAV $${d.navUsd.toFixed(2)}${d.navStale ? " · NAV stale" : ""})`,
    })),
    ...feed.corporateActions.map((c) => ({
      at: c.at,
      html: `<strong>${escapeHtml(c.ticker)}</strong> ${escapeHtml(c.kind)} — ${escapeHtml(c.detail)}${c.effectiveAt ? ` (effective ${escapeHtml(c.effectiveAt)})` : ""}`,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StockSentinel — tokenized-stock watchdog on Base</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 2rem auto; max-width: 1080px; padding: 0 1rem; line-height: 1.45; }
  h1 { margin-bottom: 0.2rem; }
  .muted { opacity: 0.65; } .small { font-size: 0.82em; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0 2rem; font-size: 0.95em; }
  th, td { border-bottom: 1px solid rgba(127,127,127,0.35); padding: 0.45rem 0.5rem; text-align: left; vertical-align: top; }
  th { font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.75; }
  .badge { border-radius: 0.6em; padding: 0.05em 0.5em; font-size: 0.78em; font-weight: 600; }
  .badge.stale { background: #b58900; color: #fff; }
  .badge.disc { background: #0052ff; color: #fff; }
  tr.disc-mid td { background: rgba(0,82,255,0.07); }
  tr.disc-high td { background: rgba(200,30,30,0.10); }
  ul.signals { list-style: none; padding: 0; }
  ul.signals li { padding: 0.4rem 0; border-bottom: 1px dashed rgba(127,127,127,0.3); }
  footer { margin-top: 2.5rem; font-size: 0.85em; }
</style>
</head>
<body>
<header>
  <h1>StockSentinel</h1>
  <p class="muted">Autonomous watchdog for tokenized stocks (B20) on Base — DEX price vs Chainlink NAV dislocations, corporate-action radar (ERC-8056 events + multiplier diffs), supply tracking.<br>
  Snapshot: ${escapeHtml(snapshot.at.replace("T", " ").slice(0, 19))} UTC · Universe: ${feed.coverage.tokensInUniverse} tokenized stocks · Monitored: ${feed.coverage.tickersMonitored} tickers (${feed.coverage.withDexPrice} with a DEX price, ${feed.coverage.withNav} with NAV)</p>
</header>

<h2>Monitored tickers</h2>
<table>
  <thead><tr><th>Ticker</th><th>DEX price</th><th>NAV (Chainlink)</th><th>Δ DEX vs NAV</th><th>Supply (tokens)</th><th>Multiplier</th><th>Pool depth</th></tr></thead>
  <tbody>
${tickers.map(tickerRow).join("\n")}
  </tbody>
</table>

<h2>Latest signals &amp; events (${signals.length})</h2>
${signals.length === 0 ? '<p class="muted">No signals in the latest cycle.</p>' : `<ul class="signals">\n${signals.map((s) => `<li><span class="muted small">${escapeHtml(s.at.replace("T", " ").slice(0, 16))} UTC</span> — ${s.html}</li>`).join("\n")}\n</ul>`}

<footer class="muted">
  ${opts.anchorInfo ? `<p>Onchain anchor (Base Sepolia): ${escapeHtml(opts.anchorInfo)}</p>` : ""}
  <p>Research/monitoring only. Not financial advice. No trading is executed for anyone. Data: official Tokenized Stocks API + Chainlink feeds + Aerodrome pools on Base mainnet; corporate-action events from B20 token precompiles (ERC-8056).</p>
</footer>
</body>
</html>
`;
}
