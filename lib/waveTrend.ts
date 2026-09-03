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
// territory at all.
const OVERSOLD = -60;
const OVERBOUGHT = 60;
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
  direction: "short" | "long"
): number | null {
  for (let i = Math.max(fromIndex, 0); i <= toIndex; i++) {
    const v = wt2[i];
    if (Number.isNaN(v)) continue;
    if (direction === "long" ? v <= OVERSOLD : v >= OVERBOUGHT) return i;
  }
  return null;
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
