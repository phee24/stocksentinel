import { test } from "node:test";
import assert from "node:assert/strict";
import { assessNav, computeDislocation } from "../src/engine/dislocation.js";

test("frozen NAV outside market hours: weekend staleness is detected and flagged on signals", () => {
  // Feed last updated Friday 21:00 UTC (US market close); it is now Sunday noon UTC.
  const updatedAt = new Date("2026-11-20T21:00:00Z");
  const now = new Date("2026-11-22T12:00:00Z");
  const nav = assessNav(updatedAt, now, 30);
  assert.equal(nav.weekendUtc, true);
  assert.equal(nav.stale, true);
  assert.ok(nav.ageHours > 38 && nav.ageHours < 40, `age ${nav.ageHours}h`);

  // DEX kept trading over the weekend and drifted +3.5% over the frozen NAV:
  // the signal must fire and must carry the stale flag.
  const signal = computeDislocation({
    ticker: "NVDA",
    navUsd: 129.82,
    dexUsd: 129.82 * 1.035,
    navStale: nav.stale,
    thresholdPct: 2.0,
  });
  assert.ok(signal);
  assert.equal(signal.navStale, true);
  assert.equal(signal.direction, "premium");
  assert.ok(Math.abs(signal.pct - 3.5) < 0.01);
});

test("fresh NAV during market hours is not stale", () => {
  const updatedAt = new Date("2026-11-18T15:00:00Z"); // Wednesday
  const now = new Date("2026-11-18T15:20:00Z");
  const nav = assessNav(updatedAt, now, 30);
  assert.equal(nav.stale, false);
  assert.equal(nav.weekendUtc, false);
});

test("dislocation above threshold: premium and discount both fire with correct sign", () => {
  const premium = computeDislocation({
    ticker: "AAPL",
    navUsd: 345.3,
    dexUsd: 345.3 * 1.028,
    navStale: false,
    thresholdPct: 2.0,
  });
  assert.ok(premium);
  assert.equal(premium.direction, "premium");
  assert.ok(Math.abs(premium.pct - 2.8) < 0.01);

  const discount = computeDislocation({
    ticker: "TSLA",
    navUsd: 350.45,
    dexUsd: 350.45 * 0.965,
    navStale: false,
    thresholdPct: 2.0,
  });
  assert.ok(discount);
  assert.equal(discount.direction, "discount");
  assert.ok(Math.abs(discount.pct + 3.5) < 0.01);
});

test("dislocation below threshold and invalid prices produce no signal", () => {
  assert.equal(
    computeDislocation({ ticker: "MSFT", navUsd: 489.2, dexUsd: 489.2 * 1.01, navStale: false, thresholdPct: 2.0 }),
    null,
  );
  assert.equal(
    computeDislocation({ ticker: "MSFT", navUsd: 0, dexUsd: 100, navStale: false, thresholdPct: 2.0 }),
    null,
  );
  assert.equal(
    computeDislocation({ ticker: "MSFT", navUsd: 100, dexUsd: -5, navStale: false, thresholdPct: 2.0 }),
    null,
  );
});
