import type { Candle } from "@/lib/kite";
import { emaSeries, smaSeries } from "@/lib/indicators";

// Standard parameters from LazyBear's public "WaveTrend [WT]" script — the
// open oscillator Market Cipher B is built on top of. Computed on real
// OHLC, not Heikin Ashi, matching lib/rsiDipBacktest.ts's own reasoning for
// its oscillator: true price extremes are what an overbought/oversold
// reading needs, and HA's smoothing would blunt exactly that.
const CHANNEL_LENGTH = 10;
const AVG_LENGTH = 21;
const MA_LENGTH = 4;

/**
 * wt1 (fast) and wt2 (slow — a 4-bar SMA of wt1, the line this module
 * actually watches; see OVERSOLD/OVERBOUGHT below).
 */
export function computeWaveTrend(
  candles: Candle[],
  channelLength: number = CHANNEL_LENGTH,
  avgLength: number = AVG_LENGTH,
  maLength: number = MA_LENGTH
): { wt1: number[]; wt2: number[] } {
  const ap = candles.map((c) => (c.high + c.low + c.close) / 3); // hlc3
  const esa = emaSeries(ap, channelLength);
  const absDiff = ap.map((v, i) => (Number.isNaN(esa[i]) ? NaN : Math.abs(v - esa[i])));
  const d = emaSeries(absDiff, channelLength);
  const ci = ap.map((v, i) => {
    if (Number.isNaN(esa[i]) || Number.isNaN(d[i]) || d[i] === 0) return NaN;
    return (v - esa[i]) / (0.015 * d[i]);
  });
  const wt1 = emaSeries(ci, avgLength);
  const wt2 = smaSeries(wt1, maLength);
  return { wt1, wt2 };
}

// wt2 (the slower line) breaching this level is the whole signal — no wt1
// crossover required, just reaching this deep into oversold/overbought
// territory at all. Default for the main strategy's WT/Double WT
// confirmation checks below — Strategy Tab 2 (lib/wtStrategy.ts) passes its
// own, higher threshold explicitly rather than sharing this one, since the
// two serve different purposes (a confirmation signal vs. the sole entry
// gate) and were tuned separately.
const DEFAULT_THRESHOLD = 50;
// How many trading days either side of the Supertrend/SMA crossover a
// breach still counts as confirming it — it can happen before OR after,
// unlike the volume-spike check's trailing-only window (see
// lib/volumeSpike.ts).
const MATCH_WINDOW_DAYS = 10;

export type WaveTrendCheck = {
  status: "confirmed" | "not_confirmed" | "pending";
  breachDate: string | null;
  wt2AtBreach: number | null; // how deep past the level wt2 was
};

/**
 * Scans wt2 for the first same-direction threshold breach between
 * fromIndex and toIndex inclusive: wt2 <= OVERSOLD counts as confirming a
 * "long" signal, wt2 >= OVERBOUGHT confirms a "short". Exported standalone
 * from checkWaveTrendConfirmation so the threshold logic itself — the part
 * that's actually load-bearing — can be unit-tested against a hand-built
 * wt2 array without needing real price data to coax a specific value out of
 * the nested-EMA math above.
 */
export function findThresholdBreachIndex(
  wt2: number[],
  fromIndex: number,
  toIndex: number,
  direction: "short" | "long",
  threshold: number = DEFAULT_THRESHOLD
): number | null {
  for (let i = Math.max(fromIndex, 0); i <= toIndex; i++) {
    const v = wt2[i];
    if (Number.isNaN(v)) continue;
    if (direction === "long" ? v <= -threshold : v >= threshold) return i;
  }
  return null;
}

/**
 * Given that wt2[todayIndex] already breaches the threshold, walks
 * backward to find how far the CURRENT, unbroken excursion actually
 * extends — the earliest index, ending at todayIndex, where every day in
 * between also breached. A single non-breaching (or NaN) day stops the
 * walk. Lets a caller show "breached on <the day the move actually
 * started>" instead of always "today", when a stock has been sitting past
 * the threshold for several sessions rather than just crossing it now.
 */
export function findBreachStartIndex(
  wt2: number[],
  todayIndex: number,
  direction: "short" | "long",
  threshold: number = DEFAULT_THRESHOLD
): number {
  const breached = (v: number) => (direction === "long" ? v <= -threshold : v >= threshold);
  let start = todayIndex;
  for (let i = todayIndex - 1; i >= 0; i--) {
    const v = wt2[i];
    if (Number.isNaN(v) || !breached(v)) break;
    start = i;
  }
  return start;
}

/**
 * Checks whether the reversal signal that crossed over at signalIndex was
 * (or still could be) confirmed by wt2 breaching the same-direction
 * threshold within MATCH_WINDOW_DAYS trading days either side of it.
 * Mirrors lib/volumeSpike.ts's checkVolumeSpike in shape (same status
 * vocabulary, same "pending" meaning: the window hasn't finished yet on a
 * live, still-open signal) but symmetric rather than trailing-only, and —
 * unlike volume — direction-aware: an overbought breach never confirms a
 * long signal or vice versa.
 *
 * candles must be the same array (or a longer one) that produced the
 * signal, indexed the same way — i.e. candles[signalIndex] is the
 * crossover's own candle.
 */
export function checkWaveTrendConfirmation(
  candles: Candle[],
  signalIndex: number,
  direction: "short" | "long"
): WaveTrendCheck {
  const { wt2 } = computeWaveTrend(candles);
  const from = Math.max(0, signalIndex - MATCH_WINDOW_DAYS);
  const to = Math.min(candles.length - 1, signalIndex + MATCH_WINDOW_DAYS);
  const idx = findThresholdBreachIndex(wt2, from, to, direction);
  if (idx !== null) {
    return { status: "confirmed", breachDate: candles[idx].date, wt2AtBreach: wt2[idx] };
  }
  const windowComplete = signalIndex + MATCH_WINDOW_DAYS < candles.length;
  return { status: windowComplete ? "not_confirmed" : "pending", breachDate: null, wt2AtBreach: null };
}

// How far back a "Double WT" pattern is allowed to reach for its first
// breach, counted from the day of its second (confirming) breach — not from
// the Supertrend/SMA crossover day. Separate from MATCH_WINDOW_DAYS above,
// which is how far the whole pattern's completion day can sit from the
// crossover.
const DOUBLE_LOOKBACK_DAYS = 20;

export type DoubleWaveTrendCheck = {
  status: "confirmed" | "not_confirmed" | "pending";
  secondBreachDate: string | null;
  wt2AtSecondBreach: number | null;
};

/**
 * Finds a same-direction "Double WT" pattern completing at or before asOf,
 * within the DOUBLE_LOOKBACK_DAYS trading days ending there: wt2 breaches
 * the threshold, recovers all the way back to recoveryLevel (a shallower
 * level than threshold — e.g. threshold 55 recovering to 45, not merely
 * ticking back under 55), then breaches the threshold again — the
 * oscillator equivalent of a double bottom/top. A partial pull-back that
 * never reaches recoveryLevel doesn't count as a recovery at all, so
 * re-breaching after one is still the SAME excursion, not a double.
 * Returns the index of the confirming second breach (the earliest one
 * found scanning forward from fromIndex), or null.
 *
 * recoveryLevel defaults to threshold itself, which reduces to the old
 * "any day back inside the band counts" behavior — the main strategy's
 * checkDoubleWaveTrend below relies on that default and is unaffected by
 * this parameter.
 *
 * Exported standalone from checkDoubleWaveTrend so the pattern logic
 * itself can be unit-tested against a hand-built wt2 array, same reasoning
 * as findThresholdBreachIndex above.
 */
export function findDoubleBreachIndex(
  wt2: number[],
  asOf: number,
  lookbackDays: number,
  direction: "short" | "long",
  threshold: number = DEFAULT_THRESHOLD,
  recoveryLevel: number = threshold
): number | null {
  const breached = (v: number) => (direction === "long" ? v <= -threshold : v >= threshold);
  const recovered = (v: number) => (direction === "long" ? v >= -recoveryLevel : v <= recoveryLevel);
  const from = Math.max(0, asOf - lookbackDays);
  let sawFirstBreach = false;
  let recoveredSince = false;
  for (let i = from; i <= asOf; i++) {
    const v = wt2[i];
    if (Number.isNaN(v)) continue;
    if (breached(v)) {
      if (sawFirstBreach && recoveredSince) return i;
      sawFirstBreach = true;
      recoveredSince = false;
    } else if (sawFirstBreach && recovered(v)) {
      recoveredSince = true;
    }
  }
  return null;
}

/**
 * Checks whether a Double WT pattern (see findDoubleBreachIndex) completed
 * on any day within MATCH_WINDOW_DAYS trading days either side of the
 * Supertrend/SMA crossover at signalIndex — same outer window and same
 * status vocabulary as checkWaveTrendConfirmation, just requiring the
 * stronger breach-recover-breach pattern instead of a single breach.
 *
 * candles must be the same array (or a longer one) that produced the
 * signal, indexed the same way — i.e. candles[signalIndex] is the
 * crossover's own candle.
 */
export function checkDoubleWaveTrend(
  candles: Candle[],
  signalIndex: number,
  direction: "short" | "long"
): DoubleWaveTrendCheck {
  const { wt2 } = computeWaveTrend(candles);
  const matchFrom = Math.max(0, signalIndex - MATCH_WINDOW_DAYS);
  const matchTo = Math.min(candles.length - 1, signalIndex + MATCH_WINDOW_DAYS);
  for (let asOf = matchFrom; asOf <= matchTo; asOf++) {
    const idx = findDoubleBreachIndex(wt2, asOf, DOUBLE_LOOKBACK_DAYS, direction);
    if (idx !== null) {
      return { status: "confirmed", secondBreachDate: candles[idx].date, wt2AtSecondBreach: wt2[idx] };
    }
  }
  const windowComplete = signalIndex + MATCH_WINDOW_DAYS < candles.length;
  return { status: windowComplete ? "not_confirmed" : "pending", secondBreachDate: null, wt2AtSecondBreach: null };
}
