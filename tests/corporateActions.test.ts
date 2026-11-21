import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffMultiplier,
  diffNavFreeze,
  diffNewListings,
} from "../src/engine/corporateActions.js";

test("corporate action changing the multiplier: split-like increase is flagged", () => {
  // SNDKc trades with multiplier 8 after its split-style adjustment.
  const signal = diffMultiplier("SNDK", 1, 8);
  assert.ok(signal);
  assert.equal(signal.kind, "multiplier_applied");
  assert.match(signal.detail, /1 -> 8/);
  assert.match(signal.detail, /split-like/);
});

test("corporate action changing the multiplier: halving (reverse-split-like) is flagged", () => {
  const signal = diffMultiplier("XYZ", 2, 1);
  assert.ok(signal);
  assert.equal(signal.kind, "multiplier_applied");
  assert.match(signal.detail, /reverse-split-like/);
});

test("dividend-reinvestment drift below the flag threshold is NOT a signal", () => {
  // Observed live drift pattern: 1.0003771186767842 -> 1.0004 is ~0.002%.
  assert.equal(diffMultiplier("GOOGL", 1.0003771186767842, 1.0004), null);
  assert.equal(diffMultiplier("NVDA", 1.0005379395763694, 1.0005379395763694), null);
});

test("multiplier diff with unknown values produces no signal", () => {
  assert.equal(diffMultiplier("AAPL", null, 2), null);
  assert.equal(diffMultiplier("AAPL", 1, undefined), null);
  assert.equal(diffMultiplier("AAPL", 0, 2), null);
});

test("NAV freeze fires only on the fresh -> stale transition", () => {
  const at = new Date("2026-11-22T12:00:00Z");
  const signal = diffNavFreeze("META", false, true, "2026-11-20T21:15:17Z", at);
  assert.ok(signal);
  assert.equal(signal.kind, "nav_frozen");
  // Already stale last cycle -> no repeat signal.
  assert.equal(diffNavFreeze("META", true, true, "2026-11-20T21:15:17Z", at), null);
  // Still fresh -> no signal.
  assert.equal(diffNavFreeze("META", false, false, "2026-11-22T11:00:00Z", at), null);
  // First-ever snapshot (no baseline) -> no signal.
  assert.equal(diffNavFreeze("META", null, true, "2026-11-20T21:15:17Z", at), null);
});

test("new listings are detected against the previous universe", () => {
  const signals = diffNewListings(new Set(["NVDA", "AAPL"]), ["NVDA", "AAPL", "TSLA"]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].ticker, "TSLA");
  assert.equal(signals[0].kind, "new_listing");
  assert.deepEqual(diffNewListings(null, ["NVDA"]), []);
});
