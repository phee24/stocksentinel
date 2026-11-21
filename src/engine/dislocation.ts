export interface DislocationSignal {
  ticker: string;
  navUsd: number;
  dexUsd: number;
  /** (dex - nav) / nav * 100. Positive = DEX premium over NAV. */
  pct: number;
  direction: "premium" | "discount";
  navStale: boolean;
  at: string; // ISO timestamp
}

export interface NavAssessment {
  ageHours: number;
  /** True when the feed has not updated within the staleness bound. */
  stale: boolean;
  /** Sat/Sun UTC — the underlying US market is closed, so a carried NAV is expected. */
  weekendUtc: boolean;
}

/**
 * Assess a NAV reading's freshness. Chainlink equity feeds update 24/5 and
 * hold their last value outside market hours, so staleness must be judged
 * against a bound (config.navStaleHours), not against "right now".
 */
export function assessNav(updatedAt: Date, now: Date, staleHours: number): NavAssessment {
  const ageHours = (now.getTime() - updatedAt.getTime()) / 3_600_000;
  const day = now.getUTCDay();
  return {
    ageHours,
    stale: ageHours > staleHours,
    weekendUtc: day === 0 || day === 6,
  };
}

/**
 * Core dislocation check: tokenized stocks trade 24/7 on DEXes while their
 * Chainlink NAV follows the underlying market (24/5, frozen during corporate
 * actions) — the gap between the two is the signal StockSentinel exists for.
 */
export function computeDislocation(args: {
  ticker: string;
  navUsd: number;
  dexUsd: number;
  navStale: boolean;
  thresholdPct: number;
}): DislocationSignal | null {
  const { ticker, navUsd, dexUsd, navStale, thresholdPct } = args;
  if (!(navUsd > 0) || !(dexUsd > 0)) return null;
  const pct = ((dexUsd - navUsd) / navUsd) * 100;
  if (Math.abs(pct) < thresholdPct) return null;
  return {
    ticker,
    navUsd,
    dexUsd,
    pct,
    direction: pct >= 0 ? "premium" : "discount",
    navStale,
    at: new Date().toISOString(),
  };
}
