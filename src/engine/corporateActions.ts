/**
 * Corporate-action radar for B20 tokenized stocks.
 *
 * Sources (all public):
 *  - Tokenized Stocks API: /corporate-actions/{id} + multiplier / NAV fields.
 *  - Onchain events: UIMultiplierUpdated (scheduled via ERC-8056 with an
 *    effectiveAt timestamp = advance notice), UIMultiplierUpdateCancelled,
 *    Announcement / EndAnnouncement, B20Created (new listings).
 *  - NAV staleness: a frozen feed (nav_price_updated_at / latestRoundData
 *    updatedAt not advancing) is itself a signal that a corporate action is
 *    being processed or that the underlying market is closed.
 *
 * This module holds the pure diff/detection logic used by the cycle:
 * snapshot N vs snapshot N-1. Event-log scanning (ERC-8056 schedule radar)
 * layers on top of these in build D4.
 */
export interface CorporateActionSignal {
  ticker: string;
  kind: "multiplier_scheduled" | "multiplier_applied" | "multiplier_cancelled" | "announcement" | "nav_frozen" | "new_listing";
  detail: string;
  effectiveAt?: string; // ISO timestamp, for scheduled multiplier changes
  at: string; // ISO timestamp detected
}

/**
 * Relative multiplier move at/above which a change counts as a corporate
 * action. Multipliers also drift by tiny amounts as dividends are reinvested
 * (observed live: 1.000377, 1.000538, ...) — those drifts are recorded in the
 * snapshot but are not signals.
 */
export const MULTIPLIER_FLAG_REL = 0.0005; // 0.05%

function fmt(x: number): string {
  return Number(x.toPrecision(6)).toString();
}

/**
 * Multiplier changed between snapshots (split / dividend adjustment applied).
 * Returns null when either side is unknown, unchanged, or only drifted.
 */
export function diffMultiplier(
  ticker: string,
  prev: number | null | undefined,
  next: number | null | undefined,
  at: Date = new Date(),
): CorporateActionSignal | null {
  if (prev == null || next == null || !(prev > 0) || !(next > 0)) return null;
  const rel = (next - prev) / prev;
  if (Math.abs(rel) < MULTIPLIER_FLAG_REL) return null;
  const ratio = next / prev;
  const shape =
    ratio >= 1.5
      ? `~${fmt(ratio)}x increase (split-like)`
      : ratio <= 2 / 3
        ? `~${fmt(1 / ratio)}x decrease (reverse-split-like)`
        : `${rel >= 0 ? "+" : ""}${(rel * 100).toFixed(2)}% adjustment`;
  return {
    ticker,
    kind: "multiplier_applied",
    detail: `multiplier ${fmt(prev)} -> ${fmt(next)} (${shape}); token-to-share ratio changed`,
    at: at.toISOString(),
  };
}

/**
 * NAV feed transitioned from fresh to stale (freeze detected). Emitted only
 * on the transition so a long weekend does not spam the feed every cycle.
 */
export function diffNavFreeze(
  ticker: string,
  prevStale: boolean | null | undefined,
  currStale: boolean,
  navUpdatedAt: string | null,
  at: Date = new Date(),
): CorporateActionSignal | null {
  if (!currStale || prevStale === true || prevStale == null) return null;
  return {
    ticker,
    kind: "nav_frozen",
    detail: `NAV feed stopped advancing (last update ${navUpdatedAt ?? "unknown"}) — corporate action being processed or market closed`,
    at: at.toISOString(),
  };
}

/** Tickers present now that were absent from the previous snapshot. */
export function diffNewListings(
  prevTickers: ReadonlySet<string> | null,
  currTickers: readonly string[],
  at: Date = new Date(),
): CorporateActionSignal[] {
  if (!prevTickers) return [];
  return currTickers
    .filter((t) => !prevTickers.has(t))
    .map((ticker) => ({
      ticker,
      kind: "new_listing" as const,
      detail: `${ticker} appeared in the monitored universe`,
      at: at.toISOString(),
    }));
}
