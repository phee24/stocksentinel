import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDashboard, escapeHtml } from "../src/report/dashboard.js";
import { buildTokenReport } from "../src/report/tokenReport.js";
import type { Snapshot } from "../src/store.js";
import type { SignalFeed } from "../src/report/brief.js";

function snap(at: string, disc: number | null, mult = 1): Snapshot {
  return {
    at,
    tickers: {
      NVDA: {
        ticker: "NVDA",
        symbol: "NVDAc",
        address: "0xb20000000000000000000078ee7ce2fE4908108C",
        navUsd: 130,
        navUpdatedAt: "2026-11-20T21:00:00Z",
        navStale: true,
        dexUsd: disc == null ? null : 130 * (1 + disc / 100),
        poolAddress: "0xpool",
        poolType: "classic",
        poolDepthUsd: 123456,
        dislocationPct: disc,
        multiplier: mult,
        totalSupply: 1000,
      },
    },
  };
}

const feed: SignalFeed = {
  generatedAt: "2026-11-21T08:00:00Z",
  agent: "StockSentinel",
  network: "base-mainnet (data) + base-sepolia (anchors)",
  coverage: { tokensInUniverse: 415, tickersMonitored: 10, withDexPrice: 10, withNav: 10 },
  dislocations: [],
  corporateActions: [
    { ticker: "NVDA", kind: "announcement", detail: 'issuer announcement onchain: "dividend <b>test</b>"', at: "2026-11-21T07:00:00Z" },
  ],
};

test("dashboard renders the ticker table, stale badge and signals, with HTML escaped", () => {
  const html = buildDashboard(snap("2026-11-21T08:00:00Z", -3.8), feed);
  assert.match(html, /NVDA/);
  assert.match(html, /NAV stale/);
  assert.match(html, /-3\.80%/);
  assert.match(html, /dividend &lt;b&gt;test&lt;\/b&gt;/); // escaped, not raw markup
  assert.doesNotMatch(html, /dividend <b>test<\/b>/);
});

test("escapeHtml escapes the five specials", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;'");
});

test("token report summarises current state + dislocation history", () => {
  const history = [snap("2026-11-21T06:00:00Z", 1.0), snap("2026-11-21T07:00:00Z", 3.0), snap("2026-11-21T08:00:00Z", -3.8)];
  const report = buildTokenReport("NVDA", history, feed, 2);
  assert.match(report, /# StockSentinel report — NVDA/);
  assert.match(report, /Dislocation history/);
  assert.match(report, /Cycles at\/over the ±2% signal threshold: 2/);
  assert.match(report, /Recent snapshots/);
});

test("token report for an unknown ticker says so", () => {
  assert.match(buildTokenReport("ZZZZ", [], null), /No snapshots recorded/);
});
