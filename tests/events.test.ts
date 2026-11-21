import { test } from "node:test";
import assert from "node:assert/strict";
import { logToSignal, pendingToSignal, wadToMultiplier } from "../src/chain/events.js";

const WAD = 10n ** 18n;

test("wad conversion", () => {
  assert.equal(wadToMultiplier(1n * WAD), 1);
  assert.equal(wadToMultiplier(8n * WAD), 8);
  assert.ok(Math.abs(wadToMultiplier(WAD / 2n) - 0.5) < 1e-12);
});

test("UIMultiplierUpdated with a future effectiveAt is a SCHEDULED signal (SNDK split shape)", () => {
  // Real live capture: SNDK 1 -> 8, effective 2026-11-20T05:00:00Z,
  // recorded in block 59674150 (2026-11-19) — i.e. announced ahead of time.
  const signal = logToSignal(
    "SNDK",
    "UIMultiplierUpdated",
    {
      oldMultiplier: 1n * WAD,
      newMultiplier: 8n * WAD,
      effectiveAtTimestamp: 1795150800n,
    },
    new Date("2026-11-19T12:00:00Z"),
    "0x3f1dbf9658e3fc8f6d38d57793c7d864fe58647c9aae2fbf6c88eb25b67bdf65",
  );
  assert.ok(signal);
  assert.equal(signal.kind, "multiplier_scheduled");
  assert.equal(signal.effectiveAt, "2026-11-20T05:00:00.000Z");
  assert.match(signal.detail, /1 -> 8/);
});

test("UIMultiplierUpdated already effective is an APPLIED signal", () => {
  const signal = logToSignal(
    "NVDA",
    "UIMultiplierUpdated",
    { oldMultiplier: 1n * WAD, newMultiplier: 2n * WAD, effectiveAtTimestamp: 1000n },
    new Date("2026-11-21T00:00:00Z"),
    "0xabc",
  );
  assert.ok(signal);
  assert.equal(signal.kind, "multiplier_applied");
});

test("cancelled schedule becomes a multiplier_cancelled signal", () => {
  const signal = logToSignal(
    "TSLA",
    "UIMultiplierUpdateCancelled",
    { cancelledMultiplier: 3n * WAD, cancelledEffectiveAt: 1795150800n },
    new Date("2026-11-19T12:00:00Z"),
    "0xdef",
  );
  assert.ok(signal);
  assert.equal(signal.kind, "multiplier_cancelled");
  assert.match(signal.detail, /3/);
});

test("Announcement becomes an announcement signal with description + id", () => {
  const signal = logToSignal(
    "NVDA",
    "Announcement",
    { caller: "0x5da41bddc73406f246d73cbe2e319f3cfc814d9a", id: "uuid-1", description: "Stock dividend", uri: "" },
    new Date("2026-11-10T00:00:00Z"),
    "0x123",
  );
  assert.ok(signal);
  assert.equal(signal.kind, "announcement");
  assert.match(signal.detail, /Stock dividend/);
});

test("unknown events produce no signal", () => {
  assert.equal(logToSignal("NVDA", "Transfer", {}, new Date(), "0x0"), null);
});

test("pending state: live schedule -> scheduled signal; matured/mirrored -> none", () => {
  const future = new Date(Date.now() + 3_600_000);
  const live = pendingToSignal("AAPL", { uiMultiplier: 1, newMultiplier: 2, effectiveAt: future, live: true });
  assert.ok(live);
  assert.equal(live.kind, "multiplier_scheduled");
  assert.equal(
    pendingToSignal("AAPL", { uiMultiplier: 1, newMultiplier: 1, effectiveAt: future, live: false }),
    null,
  );
});
