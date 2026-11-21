import { test } from "node:test";
import assert from "node:assert/strict";
import { priceFromReserves, priceFromSqrtPriceX96 } from "../src/chain/pools.js";

test("classic pool price from reserves (live NVDAc/USDC dust pool, 2026-11-21)", () => {
  // Onchain reads: token0 = USDC reserve 5695 raw (6 dec),
  // token1 = NVDAc reserve 4433 raw (8 dec). Price must be ~$128.5.
  const price = priceFromReserves(4433n, 8, 5695n, 6);
  assert.ok(Math.abs(price - 128.47) < 0.5, `price ${price}`);
});

test("CL pool price from sqrtPriceX96 (live NVDAc/USDC Slipstream pool, 2026-11-21)", () => {
  // slot0 of 0xF668e21993f0ACd7ab00BB1cFbAeD0df28A3C8EC:
  // token0 = USDC (6 dec), token1 = NVDAc (8 dec).
  const sqrt = 69885805857548926930797517313n;
  const priceToken0InToken1 = priceFromSqrtPriceX96(sqrt, 6, 8);
  // USDC price in NVDAc terms ~0.00778 -> NVDAc price ~$128.54 (matches the
  // pool's market price at read time).
  const nvdaUsd = 1 / priceToken0InToken1;
  assert.ok(Math.abs(nvdaUsd - 128.54) < 0.5, `NVDAc price ${nvdaUsd}`);
});

test("reserve price guards against an empty stock side", () => {
  assert.equal(priceFromReserves(0n, 8, 1000n, 6), 0);
});
