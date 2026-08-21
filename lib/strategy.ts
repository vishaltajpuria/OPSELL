import type { Candle } from "@/lib/kite";
import { computeSupertrend, computeSMA } from "@/lib/indicators";

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
  targetSma: SmaPoint | null;
};

/**
 * Checks every rung of the SMA sequence (20/50/100/200) for a fresh
 * crossover of the Supertrend line on the most recent candle.
 *
 * SHORT — any SMA crossing from at/below to above the Supertrend line, while
 * Supertrend is still "up" (green) and price still above the line: read as
 * that rung's average catching up to/past the line — an exhaustion signal
 * even though Supertrend itself hasn't flipped. LONG is the mirror image
 * (Supertrend "down", an SMA crossing from at/above to below the line, price
 * below it).
 *
 * The target is always the *next* SMA further out in the sequence from
 * whichever one crossed (e.g. SMA50 crosses -> target SMA100). Multiple
 * rungs can fire on the same candle; all are returned.
 */
export function detectSignals(candles: Candle[]): StrategySignal[] {
  if (candles.length < MIN_CANDLES) return [];

  const supertrend = computeSupertrend(candles, SUPERTREND_PERIOD, SUPERTREND_MULTIPLIER);
  const smas = new Map(SMA_SEQUENCE.map((period) => [period, computeSMA(candles, period)]));

  const i = candles.length - 1;
  const prev = i - 1;
  if (prev < 0) return [];

  const curSt = supertrend[i];
  const prevSt = supertrend[prev];
  if (Number.isNaN(curSt.value) || Number.isNaN(prevSt.value)) return [];

  const close = candles[i].close;
  const signalDate = candles[i].date;
  const signals: StrategySignal[] = [];

  for (let idx = 0; idx < SMA_SEQUENCE.length; idx++) {
    const period = SMA_SEQUENCE[idx];
    const series = smas.get(period)!;
    const cur = series[i];
    const prevVal = series[prev];
    if (Number.isNaN(cur) || Number.isNaN(prevVal)) continue;

    const nextPeriod = SMA_SEQUENCE[idx + 1];
    const targetValue = nextPeriod !== undefined ? smas.get(nextPeriod)![i] : undefined;
    const targetSma: SmaPoint | null =
      nextPeriod !== undefined && targetValue !== undefined && !Number.isNaN(targetValue)
        ? { period: nextPeriod, value: targetValue }
        : null;

    const shortCross = prevVal <= prevSt.value && cur > curSt.value;
    if (shortCross && curSt.trend === "up" && close > curSt.value) {
      signals.push({
        direction: "short",
        signalDate,
        entryPrice: close,
        supertrendValue: curSt.value,
        triggerSma: { period, value: cur },
        targetSma,
      });
      continue;
    }

    const longCross = prevVal >= prevSt.value && cur < curSt.value;
    if (longCross && curSt.trend === "down" && close < curSt.value) {
      signals.push({
        direction: "long",
        signalDate,
        entryPrice: close,
        supertrendValue: curSt.value,
        triggerSma: { period, value: cur },
        targetSma,
      });
    }
  }

  return signals;
}
