import type { Candle } from "@/lib/kite";
import { computeSupertrend, computeSMA, toHeikinAshi } from "@/lib/indicators";

const SUPERTREND_PERIOD = 14;
const SUPERTREND_MULTIPLIER = 1;
// SMA10 is excluded as a trigger (too close to price, too noisy) — SMA20 and
// every rung above it are valid triggers.
const SMA_SEQUENCE = [20, 50, 100, 200] as const;

// Enough trading days for SMA200 to warm up plus a safety buffer.
const MIN_CANDLES = 210;

export type SmaPoint = { period: number; value: number };

export type StrategySignal = {
  direction: "short" | "long";
  signalDate: string;
  entryPrice: number;
  supertrendValue: number;
  triggerSma: SmaPoint;
  targetSma: SmaPoint;
};

/**
 * Checks each adjacent pair in the SMA sequence (20->50, 50->100, 100->200)
 * for a fresh crossover of the Supertrend line on the most recent candle.
 *
 * SHORT requires all of:
 *  - Supertrend "up" (green)
 *  - the Heikin Ashi candle close still above the Supertrend line
 *  - the trigger SMA just crossed from at/below the line to above it
 *  - the target SMA (next rung out) is still below the line — i.e. only the
 *    faster average has caught up to Supertrend, not the slower one yet
 *
 * LONG is the mirror image (Supertrend "down", HA close below the line, an
 * SMA crossing from at/above to below it, target SMA still above the line).
 *
 * Multiple rungs can fire on the same candle; all are returned. entryPrice
 * is the real (non-Heikin-Ashi) close, since that's what's actually tradeable.
 */
export function detectSignals(candles: Candle[]): StrategySignal[] {
  if (candles.length < MIN_CANDLES) return [];

  const supertrend = computeSupertrend(candles, SUPERTREND_PERIOD, SUPERTREND_MULTIPLIER);
  const heikinAshi = toHeikinAshi(candles);
  const smas = new Map(SMA_SEQUENCE.map((period) => [period, computeSMA(candles, period)]));

  const i = candles.length - 1;
  const prev = i - 1;
  if (prev < 0) return [];

  const curSt = supertrend[i];
  const prevSt = supertrend[prev];
  if (Number.isNaN(curSt.value) || Number.isNaN(prevSt.value)) return [];

  const haClose = heikinAshi[i].close;
  const entryPrice = candles[i].close;
  const signalDate = candles[i].date;
  const signals: StrategySignal[] = [];

  for (let idx = 0; idx < SMA_SEQUENCE.length - 1; idx++) {
    const period = SMA_SEQUENCE[idx];
    const nextPeriod = SMA_SEQUENCE[idx + 1];
    const series = smas.get(period)!;
    const targetSeries = smas.get(nextPeriod)!;

    const cur = series[i];
    const prevVal = series[prev];
    const targetValue = targetSeries[i];
    if ([cur, prevVal, targetValue].some(Number.isNaN)) continue;

    const targetSma: SmaPoint = { period: nextPeriod, value: targetValue };

    const shortCross = prevVal <= prevSt.value && cur > curSt.value;
    const targetStillBelowLine = targetValue < curSt.value;
    if (shortCross && curSt.trend === "up" && haClose > curSt.value && targetStillBelowLine) {
      signals.push({
        direction: "short",
        signalDate,
        entryPrice,
        supertrendValue: curSt.value,
        triggerSma: { period, value: cur },
        targetSma,
      });
      continue;
    }

    const longCross = prevVal >= prevSt.value && cur < curSt.value;
    const targetStillAboveLine = targetValue > curSt.value;
    if (longCross && curSt.trend === "down" && haClose < curSt.value && targetStillAboveLine) {
      signals.push({
        direction: "long",
        signalDate,
        entryPrice,
        supertrendValue: curSt.value,
        triggerSma: { period, value: cur },
        targetSma,
      });
    }
  }

  return signals;
}
