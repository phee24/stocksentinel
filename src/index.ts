import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { listAllStocks, underlyingTicker, type TokenizedStock } from "./api/tokenizedStocks.js";
import { CHAINLINK_FEEDS, readEthUsd, readFeed, readTotalSupply } from "./chain/feeds.js";
import { getDexQuote } from "./chain/pools.js";
import {
  loadRadarState,
  pendingToSignal,
  readPendingMultiplier,
  scanB20Events,
} from "./chain/events.js";
import { assessNav, computeDislocation, type DislocationSignal } from "./engine/dislocation.js";
import {
  diffMultiplier,
  diffNavFreeze,
  diffNewListings,
  type CorporateActionSignal,
} from "./engine/corporateActions.js";
import { buildDailyBrief, buildSignalFeed } from "./report/brief.js";
import { buildDashboard } from "./report/dashboard.js";
import { buildTokenReport, loadSnapshotHistory } from "./report/tokenReport.js";
import { anchorDigest } from "./anchor/signalLog.js";
import { loadLatest, saveSnapshot, type Snapshot, type TickerSnapshot } from "./store.js";

/**
 * StockSentinel main loop.
 *
 * One cycle:
 *   1. Sync the tokenized-stock universe from the official Tokenized Stocks API.
 *   2. For each ticker with a documented Chainlink feed: read NAV onchain,
 *      find its deepest Aerodrome pool and price it from onchain state,
 *      compute the DEX-vs-NAV dislocation, read supply.
 *   3. Diff against the previous snapshot -> corporate-action signals
 *      (multiplier changes, NAV freeze transitions, new listings).
 *   4. ERC-8056 radar (D4): scan B20 token logs for UIMultiplierUpdated /
 *      UIMultiplierUpdateCancelled / Announcement, and poll each token's
 *      pending-multiplier state (newUIMultiplier/effectiveAt) so a live
 *      schedule is caught even before the log scan reaches it.
 *   5. Persist the snapshot; publish the signal feed (JSON), daily brief
 *      (MD) and the static dashboard (HTML, D6).
 *   6. (D7) Once a day, anchor the brief's digest on Base Sepolia.
 */

/** Once-per-UTC-day Sepolia anchor of the brief digest; non-fatal on failure. */
async function tryDailyAnchor(briefText: string, signalCount: number): Promise<void> {
  if (!config.anchorPrivateKey || !config.signalLogAddress) return;
  const stateFile = join(config.dataDir, "anchor-state.json");
  const today = new Date().toISOString().slice(0, 10);
  let lastDay = "";
  try {
    lastDay = (JSON.parse(await readFile(stateFile, "utf8")) as { lastDay?: string }).lastDay ?? "";
  } catch {
    // no anchor yet
  }
  if (lastDay === today) return;
  try {
    const dayIndex = Math.floor(Date.now() / 86_400_000);
    const { digest, hash } = await anchorDigest(briefText, signalCount, dayIndex);
    await writeFile(
      stateFile,
      JSON.stringify(
        { lastDay: today, txHash: hash, digest, address: config.signalLogAddress, anchoredAt: new Date().toISOString() },
        null,
        2,
      ),
    );
    console.log(`anchor: digest for ${today} anchored on Base Sepolia, tx ${hash}`);
  } catch (err) {
    console.error("anchor failed (non-fatal):", err instanceof Error ? err.message : err);
  }
}

async function anchorInfoText(): Promise<string | undefined> {
  try {
    const s = JSON.parse(await readFile(join(config.dataDir, "anchor-state.json"), "utf8")) as {
      address?: string;
      txHash?: string;
      lastDay?: string;
    };
    if (s.address && s.txHash) return `SignalLog ${s.address} · last anchor ${s.lastDay ?? ""} · tx ${s.txHash}`;
  } catch {
    // no anchor yet
  }
  return undefined;
}

async function runCycle(): Promise<void> {
  const now = new Date();
  const started = now.toISOString();
  const stocks = await listAllStocks();
  const byUnderlying = new Map<string, TokenizedStock>();
  for (const s of stocks) {
    if (s.symbol) byUnderlying.set(underlyingTicker(s.symbol), s);
  }
  console.log(`[${started}] universe: ${stocks.length} tokenized stocks`);

  const ethUsd = await readEthUsd().catch(() => null);
  const prev = await loadLatest(config.dataDir);

  const tickers: Record<string, TickerSnapshot> = {};
  const dislocations: DislocationSignal[] = [];
  const corporateActions: CorporateActionSignal[] = [];

  for (const ticker of Object.keys(CHAINLINK_FEEDS)) {
    const stock = byUnderlying.get(ticker);
    const feed = await readFeed(ticker, config.navStaleHours).catch(() => null);

    const navUsd = feed?.priceUsd ?? stock?.navPrice ?? null;
    const navUpdatedAt = feed
      ? feed.updatedAt.toISOString()
      : (stock?.navPriceUpdatedAt ?? null);
    const navStale = navUpdatedAt
      ? assessNav(new Date(navUpdatedAt), now, config.navStaleHours).stale
      : false;

    const dex = stock
      ? await getDexQuote(ticker, stock.contractAddress, {
          stockDecimals: stock.decimals ?? 8,
          navUsd,
          ethUsd,
        }).catch(() => null)
      : null;

    const dislocationPct =
      navUsd != null && dex ? ((dex.priceUsd - navUsd) / navUsd) * 100 : null;
    if (navUsd != null && dex) {
      const signal = computeDislocation({
        ticker,
        navUsd,
        dexUsd: dex.priceUsd,
        navStale,
        thresholdPct: config.dislocationAlertPct,
      });
      if (signal) dislocations.push(signal);
    }

    let totalSupply: number | null = stock?.totalSupply ?? null;
    if (stock) {
      totalSupply = await readTotalSupply(stock.contractAddress, stock.decimals ?? 8).catch(
        () => totalSupply,
      );
    }

    tickers[ticker] = {
      ticker,
      symbol: stock?.symbol ?? ticker,
      address: stock?.contractAddress ?? "",
      navUsd,
      navUpdatedAt,
      navStale,
      dexUsd: dex?.priceUsd ?? null,
      poolAddress: dex?.poolAddress ?? null,
      poolType: dex?.poolType ?? null,
      poolDepthUsd: dex?.reserveUsdApprox ?? null,
      dislocationPct,
      multiplier: stock?.multiplier ?? null,
      totalSupply,
    };

    const prevTicker = prev?.tickers[ticker];
    const mult = diffMultiplier(ticker, prevTicker?.multiplier, stock?.multiplier ?? null, now);
    if (mult) corporateActions.push(mult);
    const freeze = diffNavFreeze(ticker, prevTicker?.navStale, navStale, navUpdatedAt, now);
    if (freeze) corporateActions.push(freeze);

    const t = tickers[ticker];
    console.log(
      `  ${ticker}: NAV ${t.navUsd == null ? "n/a" : `$${t.navUsd.toFixed(2)}`}${t.navStale ? " (STALE)" : ""}` +
        ` · DEX ${t.dexUsd == null ? "n/a" : `$${t.dexUsd.toFixed(2)}`}` +
        ` · Δ ${t.dislocationPct == null ? "n/a" : `${t.dislocationPct >= 0 ? "+" : ""}${t.dislocationPct.toFixed(2)}%`}` +
        ` · supply ${t.totalSupply == null ? "n/a" : t.totalSupply.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    );
  }
  corporateActions.push(
    ...diffNewListings(
      prev ? new Set(Object.keys(prev.tickers)) : null,
      Object.keys(tickers),
      now,
    ),
  );

  // --- D4: ERC-8056 onchain radar (event logs + pending-multiplier state) ---
  const radarTokens = Object.values(tickers)
    .filter((t) => t.address)
    .map((t) => ({ ticker: t.ticker, address: t.address }));
  const pendingKeys = new Set<string>();
  try {
    const radarState = await loadRadarState(config.dataDir);
    const alreadySeen = new Set(radarState?.seen ?? []);
    for (const t of radarTokens) {
      const pending = await readPendingMultiplier(t.address);
      if (!pending?.live) continue;
      const key = `pending:${t.address.toLowerCase()}:${pending.effectiveAt.toISOString()}:${pending.newMultiplier}`;
      pendingKeys.add(key);
      if (!alreadySeen.has(key)) {
        const signal = pendingToSignal(t.ticker, pending, now);
        if (signal) corporateActions.push(signal);
      }
    }
    const scan = await scanB20Events(config.dataDir, radarTokens, pendingKeys);
    corporateActions.push(...scan.signals);
    console.log(
      `  radar: scanned blocks ${scan.fromBlock.toString()}..${scan.toBlock.toString()}, ${scan.logsSeen} log(s), ${scan.signals.length} new event signal(s)`,
    );
  } catch (err) {
    console.error("radar failed (non-fatal):", err instanceof Error ? err.message : err);
  }

  const snapshot: Snapshot = { at: started, tickers };
  const snapshotFile = await saveSnapshot(config.dataDir, snapshot);

  const feed = buildSignalFeed(dislocations, corporateActions, {
    tokensInUniverse: stocks.length,
    tickersMonitored: Object.keys(tickers).length,
    withDexPrice: Object.values(tickers).filter((t) => t.dexUsd != null).length,
    withNav: Object.values(tickers).filter((t) => t.navUsd != null).length,
  });
  const brief = buildDailyBrief(feed, snapshot);

  const feedsDir = join(config.dataDir, "feeds");
  const briefsDir = join(config.dataDir, "briefs");
  await mkdir(feedsDir, { recursive: true });
  await mkdir(briefsDir, { recursive: true });
  await writeFile(join(config.dataDir, "feed.json"), JSON.stringify(feed, null, 2));
  await writeFile(
    join(feedsDir, `feed-${started.replace(/[:.]/g, "-")}.json`),
    JSON.stringify(feed, null, 2),
  );
  await writeFile(join(briefsDir, `brief-${started.slice(0, 10)}.md`), brief);

  // --- D6: static dashboard ---
  const dashboard = buildDashboard(snapshot, feed, { anchorInfo: await anchorInfoText() });
  await writeFile(join(config.dataDir, "dashboard.html"), dashboard);
  try {
    const docsDir = join(config.dataDir, "..", "..", "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "index.html"), dashboard);
  } catch {
    // docs copy is best-effort (GitHub Pages staging)
  }

  console.log(
    `cycle done: ${dislocations.length} dislocation signal(s), ${corporateActions.length} corporate-action signal(s); snapshot ${snapshotFile}`,
  );
  if (process.argv.includes("--report")) console.log(`\n${brief}`);

  // --- D7: daily Sepolia anchor ---
  await tryDailyAnchor(brief, dislocations.length + corporateActions.length);
}

/** D8: one-shot per-token report from the stored snapshot history. */
async function tokenReport(ticker: string): Promise<void> {
  const history = await loadSnapshotHistory(config.dataDir);
  let feed = null;
  try {
    feed = JSON.parse(await readFile(join(config.dataDir, "feed.json"), "utf8"));
  } catch {
    // no feed yet
  }
  const report = buildTokenReport(ticker, history, feed, config.dislocationAlertPct);
  const dir = join(config.dataDir, "reports");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${ticker.toUpperCase()}.md`);
  await writeFile(file, report);
  console.log(report);
  console.log(`\n[saved to ${file}]`);
}

async function main(): Promise<void> {
  const tokenIdx = process.argv.indexOf("--token");
  if (tokenIdx >= 0) {
    const ticker = process.argv[tokenIdx + 1];
    if (!ticker) throw new Error("usage: --token <TICKER>");
    await tokenReport(ticker);
    return;
  }
  const once = process.argv.includes("--once");
  console.log("StockSentinel starting (track: Agentic Stock Finance)");
  await runCycle();
  if (once) return;
  setInterval(() => {
    runCycle().catch((err) => console.error("cycle failed:", err));
  }, config.pollIntervalMs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
