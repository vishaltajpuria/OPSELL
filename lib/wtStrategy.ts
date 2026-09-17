import type { Candle } from "@/lib/kite";
import {
  computeWaveTrend,
  findThresholdBreachIndex,
  findBreachStartIndex,
  findDoubleBreachIndex,
} from "@/lib/waveTrend";
import { resampleToWeekly } from "@/lib/indicators";
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

// How far back inside the band wt2 must actually travel to count as
// "recovered" between the two breaches of a Double WT pattern — shallower
// than WT_THRESHOLD (55) itself, so a mere tick back under 55 doesn't
// count; it has to genuinely retreat to 45 before a re-breach counts as a
// second, separate excursion rather than a continuation of the first.
const DWT_RECOVERY_LEVEL = 45;

export type WtStrategySignal = {
  direction: "short" | "long";
  // The gate is today's wt2 itself being beyond +-WT_THRESHOLD — not a
  // lookback window. wtBreachDate, though, is the day the CURRENT unbroken
  // excursion actually started (see findBreachStartIndex) — a stock that's
  // been sitting past the threshold for several sessions shows that
  // earlier date, not today's, even though it still qualifies today. Double
  // WT below is an additional tick shown on top, same role as volumeSpike;
  // it no longer changes whether a stock makes the list at all.
  wtBreachDate: string;
  // Today's own wt2 reading (not the value at wtBreachDate) — how deep the
  // oscillator is RIGHT NOW, which is what the gate itself checks and what
  // the page's ranking treats as "WT strength".
  wt2AtSignal: number;
  // How many daily candles, counting today, the current unbroken excursion
  // has run — i.e. the same span wtBreachDate marks the start of, expressed
  // as a count rather than a date. Always >= 1 (today itself, at minimum,
  // since the gate requires today to already be breached).
  wtDays: number;
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
  // Whether the SAME-direction WT threshold is ALSO breached on the WEEKLY
  // chart (resampled from these same daily candles — see
  // resampleToWeekly) — a higher-timeframe confirmation on top of the
  // daily-only gate above. False (not just unconfirmed) when there isn't
  // enough weekly history yet for a valid reading, same as any other
  // not-yet-warmed-up indicator value. This is a HARD override in Strategy
  // Tab 2's ranking (app/strategy2/page.tsx's rankSignals) — a stock with
  // this true is placed ahead of every other stock regardless of its
  // weighted score, not just nudged by one.
  weeklyWtBreach: boolean;
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

  // Computed once, off the SAME daily candles already fetched for the
  // daily gate above — no extra Kite call needed. Whether it's warmed up
  // enough for a valid reading depends on how much daily history the
  // caller fetched (see DAILY_LOOKBACK_DAYS in lib/runWtStrategy.ts).
  const weeklyWt2 = computeWaveTrend(resampleToWeekly(candles)).wt2;
  const latestWeeklyWt2 = weeklyWt2[weeklyWt2.length - 1];

  const signals: WtStrategySignal[] = [];
  for (const direction of ["long", "short"] as const) {
    const wtIdx = findThresholdBreachIndex(wt2, i, i, direction, WT_THRESHOLD); // gate: today only
    if (wtIdx === null) continue; // today's wt2 isn't beyond the threshold -> no signal, regardless of anything else

    // How far back the current excursion actually goes — used for display
    // and as the anchor for the volume-spike window below, so a breach
    // from a few days ago still gets real trailing days to check for a
    // spike instead of always looking at "today" with nothing after it.
    const breachStartIdx = findBreachStartIndex(wt2, i, direction, WT_THRESHOLD);

    const doubleIdx = findDoubleBreachIndex(wt2, i, DWT_RECENCY_DAYS, direction, WT_THRESHOLD, DWT_RECOVERY_LEVEL);
    const gapDirection = direction === "long" ? "up" : "down";
    const weeklyWtBreach =
      !Number.isNaN(latestWeeklyWt2) &&
      (direction === "long" ? latestWeeklyWt2 <= -WT_THRESHOLD : latestWeeklyWt2 >= WT_THRESHOLD);

    signals.push({
      direction,
      wtBreachDate: candles[breachStartIdx].date,
      wt2AtSignal: wt2[i],
      wtDays: i - breachStartIdx + 1,
      hasDoubleWt: doubleIdx !== null,
      dwtDate: doubleIdx !== null ? candles[doubleIdx].date : null,
      entryPrice,
      volumeSpike: checkVolumeSpike(candles, breachStartIdx),
      nextGap: findNextGap(candles, entryPrice, 20, gapDirection),
      weeklyWtBreach,
    });
  }
  return signals;
}
