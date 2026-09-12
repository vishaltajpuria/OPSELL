import type { Candle } from "@/lib/kite";
import { computeWaveTrend, findThresholdBreachIndex, findDoubleBreachIndex } from "@/lib/waveTrend";
import { checkVolumeSpike, type VolumeSpikeCheck } from "@/lib/volumeSpike";
import { findNextGap, type GapInfo } from "@/lib/gaps";

// Enough real trading days for WT's own warm-up (channelLength 10 + avgLength
// 21 + maLength 4 ≈ 35 bars before wt2 has any valid value) plus the Double
// WT lookback (20 more) and a safety buffer — smaller than the main
// Supertrend/SMA strategy's MIN_CANDLES=210, since WT has no SMA200 to warm up.
const MIN_CANDLES = 80;

// Strategy Tab 2's own gate threshold — higher (stricter) than the main
// strategy's WT/Double WT confirmation checks (50, in lib/waveTrend.ts),
// since here WT is the SOLE entry filter rather than one of several
// confirmations layered onto an independent crossover signal.
const WT_THRESHOLD = 55;

// How many trailing trading days the WHOLE breach-recover-breach Double WT
// pattern — not just its completing breach — can span and still count as
// live. Wider than WT_RECENCY_DAYS since the pattern itself takes longer to
// play out (a breach, a recovery, then a second breach).
const DWT_RECENCY_DAYS = 20;

export type WtStrategySignal = {
  direction: "short" | "long";
  // The gate: today's wt2 itself must be beyond +-WT_THRESHOLD — not a
  // lookback window, so wtBreachDate is always today's date. Kept as an
  // explicit field (rather than assumed to be "today" implicitly) so a
  // reader doesn't have to know that rule to trust what's displayed. Double
  // WT below is an additional tick shown on top, same role as volumeSpike;
  // it no longer changes whether a stock makes the list at all.
  wtBreachDate: string;
  wt2AtSignal: number;
  // Whether wt2 ALSO completed a full breach-recover-breach pattern for
  // this direction within DWT_RECENCY_DAYS — see findDoubleBreachIndex in
  // lib/waveTrend.ts. hasDoubleWt without dwtDate never happens; dwtDate is
  // only null when hasDoubleWt is false.
  hasDoubleWt: boolean;
  dwtDate: string | null;
  entryPrice: number; // today's close
  volumeSpike: VolumeSpikeCheck;
  // Nearest still-unfilled REAL (non-Heikin-Ashi) price gap on the SAME
  // side as the signal's direction — an upside gap for "long", downside for
  // "short" — see findNextGap's direction param in lib/gaps.ts. A gap on
  // the wrong side isn't a plausible target for this signal, so it's
  // excluded rather than shown as the "nearest" one regardless of side.
  nextGap: GapInfo | null;
};

/**
 * Strategy Tab 2's own entry signal — standalone, NOT anchored to the
 * Supertrend/SMA crossover strategy in lib/strategy.ts at all (that
 * strategy plays no part here). The ONLY gate is TODAY's wt2 value itself
 * being beyond +-WT_THRESHOLD — not a lookback window; a breach from a few
 * days ago that wt2 has since moved back inside the band no longer
 * qualifies. Double WT, volume spike, and the next same-direction gap are
 * all informational ticks/annotations checked on top of a stock that
 * already qualified today — none of them can qualify a stock on their own,
 * and Double WT's own 20-day lookback (for its EARLIER, first breach) is
 * separate from this today-only gate.
 *
 * Computed on real OHLC, not Heikin Ashi — matches lib/waveTrend.ts's own
 * reasoning (true price extremes are what an oversold/overbought reading
 * needs) and applies to the gap check too (a gap is a real market
 * phenomenon, not something Heikin Ashi's smoothed candles would show).
 */
export function detectWtSignals(candles: Candle[]): WtStrategySignal[] {
  if (candles.length < MIN_CANDLES) return [];
  const { wt2 } = computeWaveTrend(candles);
  const i = candles.length - 1;
  const entryPrice = candles[i].close;

  const signals: WtStrategySignal[] = [];
  for (const direction of ["long", "short"] as const) {
    const wtIdx = findThresholdBreachIndex(wt2, i, i, direction, WT_THRESHOLD); // today only
    if (wtIdx === null) continue; // today's wt2 isn't beyond the threshold -> no signal, regardless of anything else

    const doubleIdx = findDoubleBreachIndex(wt2, i, DWT_RECENCY_DAYS, direction, WT_THRESHOLD);
    const gapDirection = direction === "long" ? "up" : "down";

    signals.push({
      direction,
      wtBreachDate: candles[wtIdx].date,
      wt2AtSignal: wt2[wtIdx],
      hasDoubleWt: doubleIdx !== null,
      dwtDate: doubleIdx !== null ? candles[doubleIdx].date : null,
      entryPrice,
      volumeSpike: checkVolumeSpike(candles, wtIdx),
      nextGap: findNextGap(candles, entryPrice, 20, gapDirection),
    });
  }
  return signals;
}
