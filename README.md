# StockSentinel

**An autonomous watchdog agent for tokenized stocks (B20) on Base.**
Entry for **Base Stocks Maxxing Season — Track: Agentic Stock Finance** (Base Builder Quest, Coinbase Technologies).

Tokenized stocks on Base trade **24/7** on DEXes, but their official NAV (Chainlink) follows the underlying equity market **24/5** and *freezes during corporate actions*. Holders are blind to two things:

1. **Dislocations** — the DEX price drifting away from NAV outside market hours.
2. **Corporate actions** — splits/dividends that change each token's redemption `multiplier`, sometimes scheduled onchain days in advance.

StockSentinel watches both, around the clock, and publishes what it finds.

## What it does

- Syncs the full Coinbase tokenized-stock universe from the official **Tokenized Stocks API** (public, no key).
- Reads **Chainlink NAV feeds** on Base mainnet and detects stale/frozen feeds.
- Compares **Aerodrome DEX prices vs NAV** (deepest classic/Slipstream pool per token, priced from onchain reserves / slot0) → premium/discount signals.
- **Corporate-action radar, three layers:** snapshot diffs (multiplier changes, NAV-freeze transitions, new listings, supply tracking); an **onchain ERC-8056 event radar** that incrementally scans every monitored B20 token's logs for `UIMultiplierUpdated` / `UIMultiplierUpdateCancelled` / issuer `Announcement` events (dedup + progress in `data/radar-state.json`); and **pending-schedule polling** of `newUIMultiplier()` / `effectiveAt()` so a live scheduled split is flagged even before the log scan reaches its block.
- Publishes a **machine-readable signal feed (JSON)**, a **daily brief** (Markdown), and a **static dashboard** (single self-contained HTML regenerated every cycle → `data/dashboard.html`, mirrored to `../docs/index.html` for GitHub Pages); snapshots are kept as a time series in `data/`.
- **Per-token reports**: `npm run token -- NVDA` builds a one-ticker Markdown report (current state, dislocation history, multiplier history, recent snapshots) from the stored time series.
- Anchors a daily digest hash on **Base Sepolia** via `SignalLog` (with an ERC-8021 Builder Code suffix) so the agent's research activity is verifiable onchain — zero mainnet funds involved. *(Wiring complete; first live anchor pending faucet funding of the project testnet wallet — see Status.)*
- Research/monitoring only. **No trading is executed for anyone.**

## Run it

```bash
npm install
cp .env.example .env   # TS_API_BASE_URL + RADAR_RPC_URL are pre-filled with verified URLs
npm run once           # one monitoring cycle
npm run dev            # continuous loop (10-minute cycles by default)
npm run token -- NVDA  # per-token report (D8)
npm test               # unit tests (engines, pool math, event radar, reports)
npm run typecheck      # tsc --noEmit
```

Real captured outputs live in `examples/`: signal feed JSON, daily brief,
raw snapshot, and the rendered dashboard. Live catches so far include
**MSTRc trading at a −3.8% discount to NAV** on Aerodrome while its
Chainlink NAV was frozen for the weekend, and the **SNDK 1 → 8 multiplier
split** recorded onchain via ERC-8056 (`UIMultiplierUpdated`, block
59674150, announced ~19 hours before its 2026-11-20T05:00Z effective time)
together with its issuer `Announcement` bracket.

## Layout

- `src/api/` — Tokenized Stocks API client
- `src/chain/` — onchain readers (Chainlink feeds, B20 tokens, Aerodrome pools, ERC-8056 event radar)
- `src/engine/` — dislocation engine, corporate-action radar (diff layer)
- `src/report/` — signal feed, daily brief, static dashboard, per-token report
- `src/anchor/` — Base Sepolia digest anchoring (`signalLog.ts`) + `deploy.ts` for `SignalLog`
- `contracts/SignalLog.sol` — attestation contract (testnet)
- `data/` — snapshots (time series), feeds, briefs, reports, dashboard, radar/anchor state

## Status

**Phase 2 (build D4, D6, D7, D8) complete — 2026-11-21**, with one external
blocker on D7's last step:

- **D4 event radar: DONE, verified on live mainnet logs.** Signatures taken
  from the official Base docs + CDP B20 event index and confirmed against
  real logs (SNDK split event + two issuer Announcements decoded from
  mainnet). First production backfill: 300k blocks; a one-off 1M-block
  backfill ingested the historical SNDK split + NVDA/SNDK announcements
  into the feed as demo material.
- **D6 dashboard: DONE.** `data/dashboard.html` + `../docs/index.html`
  regenerated every cycle (ticker table with DEX/NAV/dislocation/stale
  badge/supply/multiplier/pool depth + latest signals list).
- **D8 per-token CLI + README: DONE.** `npm run token -- <TICKER>`;
  24 unit tests passing (13 from Phase 1 + 11 new), `tsc --noEmit` clean.
- **D7 Sepolia anchor: CODE COMPLETE, funding BLOCKED.** A fresh
  project-only testnet wallet was generated (address
  `0x5397be397eFDcFBa2a4582d6869DF51bDA6261A1`; key stored outside the
  repo, mode 600 — never a wallet of the entrant's). Every legitimate
  public Base Sepolia faucet is gated from this headless VM: Alchemy's
  faucet API requires a Turnstile CAPTCHA token ("no server-to-server
  credential") plus ≥0.001 ETH mainnet balance on the requesting address;
  Coinbase/CDP, QuickNode, Chainlink and L2Faucet faucets require account
  login / social auth. **TODO (one human minute):** open
  https://www.alchemy.com/faucets/base-sepolia (or the Coinbase faucet),
  drip to `0x5397be397eFDcFBa2a4582d6869DF51bDA6261A1`, then run
  `npx tsx src/anchor/deploy.ts` and one `npm run once` — the cycle
  anchors that day's digest automatically and records the tx in
  `data/anchor-state.json`.
- **Soak run: RUNNING** as a systemd service (`stocksentinel.service`),
  10-minute cycles, logs via journald + `data/` outputs. See `../STATUS.md`
  in the project root for how to check it.

Not financial advice.
