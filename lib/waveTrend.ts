import type { Candle } from "@/lib/kite";
import { emaSeries, smaSeries } from "@/lib/indicators";

// Standard parameters from LazyBear's public "WaveTrend [WT]" script — the
// open oscillator Market Cipher B's dots are built on top of. Computed on
// real OHLC, not Heikin Ashi, matching lib/rsiDipBacktest.ts's own reasoning
// for its oscillator: true price extremes are what an overbought/oversold
// reading needs, and HA's smoothing would blunt exactly that.
const CHANNEL_LENGTH = 10;
const AVG_LENGTH = 21;
const MA_LENGTH = 4;

/**
 * wt1 (fast) and wt2 (slow, a 4-bar SMA of wt1) — the two lines whose
 * crossover, inside an overbought/oversold zone, is what the colored dots
 * on a WaveTrend/Market Cipher B chart actually mark.
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

// The inner band (Market Cipher B's dot-gating level, not the outer
// reference band drawn on the chart) — a cross has to happen at least this
// deep into oversold/overbought territory to count as a signal, not just
// any wt1/wt2 crossover near the zero line.
const OVERSOLD = -53;
const OVERBOUGHT = 53;
// How many trading days either side of the Supertrend/SMA crossover a
// matching WaveTrend dot still counts as confirming it — WaveTrend tends to
// turn at or slightly before a real reversal rather than after, unlike the
// volume-spike check's trailing-only window (see lib/volumeSpike.ts).
const MATCH_WINDOW_DAYS = 5;

export type WaveTrendCheck = {
  status: "confirmed" | "not_confirmed" | "pending";
  crossDate: string | null;
  wt2AtCross: number | null; // how deep into the zone wt2 was at the cross
};

/**
 * Scans wt1/wt2 for the first same-direction dot between fromIndex and
 * toIndex inclusive: wt1 crossing above wt2 while wt2 is still at/below
 * OVERSOLD (a "long" dot), or crossing below while wt2 is at/above
 * OVERBOUGHT (a "short" dot). Exported standalone from
 * checkWaveTrendConfirmation so the cross/zone logic itself — the part
 * that's actually load-bearing — can be unit-tested against hand-built
 * wt1/wt2 arrays without needing real price data to coax a specific cross
 * out of the nested-EMA math above.
 */
export function findConfirmingCrossIndex(
  wt1: number[],
  wt2: number[],
  fromIndex: number,
  toIndex: number,
  direction: "short" | "long"
): number | null {
  for (let i = Math.max(fromIndex, 1); i <= toIndex; i++) {
    const p1 = wt1[i - 1];
    const p2 = wt2[i - 1];
    const c1 = wt1[i];
    const c2 = wt2[i];
    if ([p1, p2, c1, c2].some(Number.isNaN)) continue;
    if (direction === "long") {
      if (p1 <= p2 && c1 > c2 && c2 <= OVERSOLD) return i;
    } else {
      if (p1 >= p2 && c1 < c2 && c2 >= OVERBOUGHT) return i;
    }
  }
  return null;
}

/**
 * Checks whether the reversal signal that crossed over at signalIndex was
 * (or still could be) confirmed by a same-direction WaveTrend dot within
 * MATCH_WINDOW_DAYS trading days either side of it. Mirrors
 * lib/volumeSpike.ts's checkVolumeSpike in shape (same status vocabulary,
 * same "pending" meaning: the window hasn't finished yet in a live,
 * still-open signal) but symmetric rather than trailing-only, and — unlike
 * volume — direction-aware: a bearish dot never confirms a long signal or
 * vice versa.
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
  const { wt1, wt2 } = computeWaveTrend(candles);
  const from = Math.max(0, signalIndex - MATCH_WINDOW_DAYS);
  const to = Math.min(candles.length - 1, signalIndex + MATCH_WINDOW_DAYS);
  const idx = findConfirmingCrossIndex(wt1, wt2, from, to, direction);
  if (idx !== null) {
    return { status: "confirmed", crossDate: candles[idx].date, wt2AtCross: wt2[idx] };
  }
  const windowComplete = signalIndex + MATCH_WINDOW_DAYS < candles.length;
  return { status: windowComplete ? "not_confirmed" : "pending", crossDate: null, wt2AtCross: null };
}
