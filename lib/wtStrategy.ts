import type { Candle } from "@/lib/kite";
import { computeWaveTrend, findThresholdBreachIndex, findDoubleBreachIndex } from "@/lib/waveTrend";
import { checkVolumeSpike, type VolumeSpikeCheck } from "@/lib/volumeSpike";

// Enough real trading days for WT's own warm-up (channelLength 10 + avgLength
// 21 + maLength 4 ≈ 35 bars before wt2 has any valid value) plus the Double
// WT lookback (20 more) and a safety buffer — smaller than the main
// Supertrend/SMA strategy's MIN_CANDLES=210, since WT has no SMA200 to warm up.
const MIN_CANDLES = 80;

// How many trailing trading days (as of today) a single WT breach still
// counts as a live signal.
const WT_RECENCY_DAYS = 10;
// How many trailing trading days the WHOLE breach-recover-breach Double WT
// pattern — not just its completing breach — can span and still count as
// live. Wider than WT_RECENCY_DAYS since the pattern itself takes longer to
// play out (a breach, a recovery, then a second breach).
const DWT_RECENCY_DAYS = 20;

export type WtStrategySignal = {
  direction: "short" | "long";
  isDouble: boolean; // true = Double WT ("Super"), false = plain WT
  signalDate: string; // day of the (completing) breach
  entryPrice: number; // today's close
  wt2AtSignal: number;
  volumeSpike: VolumeSpikeCheck;
};

/**
 * Strategy Tab 2's own entry signal — standalone, NOT anchored to the
 * Supertrend/SMA crossover strategy in lib/strategy.ts at all (that
 * strategy plays no part here). A stock qualifies, per direction, when
 * either:
 *  - Double WT: wt2 completed a breach-recover-breach pattern (see
 *    findDoubleBreachIndex in lib/waveTrend.ts) within the last
 *    DWT_RECENCY_DAYS trading days — checked first and, when it qualifies,
 *    reported INSTEAD of the plain WT signal below for that direction: it's
 *    the stronger version of the same underlying condition, same "Super"
 *    naming convention as the main Strategy tab's SMA50/100-vs-SMA20
 *    trigger.
 *  - Plain WT: wt2 breached +-50 (see findThresholdBreachIndex) within the
 *    last WT_RECENCY_DAYS trading days, with no qualifying Double WT.
 *
 * Volume-spike confirmation (lib/volumeSpike.ts) is checked against the
 * signal's own trigger day, exactly as it is for the main strategy —
 * informational only, not a gate; the caller decides what to do with it.
 *
 * Computed on real OHLC, not Heikin Ashi — see lib/waveTrend.ts's own
 * reasoning (true price extremes are what an oversold/overbought reading
 * needs).
 */
export function detectWtSignals(candles: Candle[]): WtStrategySignal[] {
  if (candles.length < MIN_CANDLES) return [];
  const { wt2 } = computeWaveTrend(candles);
  const i = candles.length - 1;
  const entryPrice = candles[i].close;

  const signals: WtStrategySignal[] = [];
  for (const direction of ["long", "short"] as const) {
    const doubleIdx = findDoubleBreachIndex(wt2, i, DWT_RECENCY_DAYS, direction);
    if (doubleIdx !== null) {
      signals.push({
        direction,
        isDouble: true,
        signalDate: candles[doubleIdx].date,
        entryPrice,
        wt2AtSignal: wt2[doubleIdx],
        volumeSpike: checkVolumeSpike(candles, doubleIdx),
      });
      continue;
    }
    const singleIdx = findThresholdBreachIndex(wt2, Math.max(0, i - WT_RECENCY_DAYS), i, direction);
    if (singleIdx !== null) {
      signals.push({
        direction,
        isDouble: false,
        signalDate: candles[singleIdx].date,
        entryPrice,
        wt2AtSignal: wt2[singleIdx],
        volumeSpike: checkVolumeSpike(candles, singleIdx),
      });
    }
  }
  return signals;
}
