import type { Candle } from "@/lib/kite";
import { computeSupertrend, computeSMA } from "@/lib/indicators";

const SUPERTREND_PERIOD = 14;
const SUPERTREND_MULTIPLIER = 1;
const TRIGGER_SMA = 20;
const TARGET_SMA_PERIODS = [50, 100, 200] as const;
const SMA_PERIODS = [10, 20, 50, 100, 200] as const;

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
 * Detects a fresh signal on the most recent candle:
 *
 * SHORT — Supertrend is in its "up" (green) state, price is still above the
 * Supertrend line, and the SMA20 has just crossed from at/below the
 * Supertrend line to above it (read as trend exhaustion despite Supertrend
 * not having flipped yet). Target is the nearest of SMA50/100/200 below price.
 *
 * LONG — the mirror image: Supertrend "down" (red), price below the line,
 * SMA20 crosses from at/above the line to below it. Target is the nearest of
 * SMA50/100/200 above price.
 */
export function detectSignal(candles: Candle[]): StrategySignal | null {
  if (candles.length < MIN_CANDLES) return null;

  const supertrend = computeSupertrend(candles, SUPERTREND_PERIOD, SUPERTREND_MULTIPLIER);
  const smas = new Map(SMA_PERIODS.map((period) => [period, computeSMA(candles, period)]));

  const i = candles.length - 1;
  const prev = i - 1;
  if (prev < 0) return null;

  const triggerSeries = smas.get(TRIGGER_SMA)!;
  const curTrigger = triggerSeries[i];
  const prevTrigger = triggerSeries[prev];
  const curSt = supertrend[i];
  const prevSt = supertrend[prev];
  if ([curTrigger, prevTrigger, curSt.value, prevSt.value].some(Number.isNaN)) return null;

  const close = candles[i].close;
  const signalDate = candles[i].date;

  const shortCross = prevTrigger <= prevSt.value && curTrigger > curSt.value;
  if (shortCross && curSt.trend === "up" && close > curSt.value) {
    return {
      direction: "short",
      signalDate,
      entryPrice: close,
      supertrendValue: curSt.value,
      triggerSma: { period: TRIGGER_SMA, value: curTrigger },
      targetSma: nearestSmaBelow(smas, i, close),
    };
  }

  const longCross = prevTrigger >= prevSt.value && curTrigger < curSt.value;
  if (longCross && curSt.trend === "down" && close < curSt.value) {
    return {
      direction: "long",
      signalDate,
      entryPrice: close,
      supertrendValue: curSt.value,
      triggerSma: { period: TRIGGER_SMA, value: curTrigger },
      targetSma: nearestSmaAbove(smas, i, close),
    };
  }

  return null;
}

function nearestSmaBelow(smas: Map<number, number[]>, i: number, price: number): SmaPoint | null {
  let best: SmaPoint | null = null;
  for (const period of TARGET_SMA_PERIODS) {
    const value = smas.get(period)![i];
    if (Number.isNaN(value) || value >= price) continue;
    if (!best || value > best.value) best = { period, value };
  }
  return best;
}

function nearestSmaAbove(smas: Map<number, number[]>, i: number, price: number): SmaPoint | null {
  let best: SmaPoint | null = null;
  for (const period of TARGET_SMA_PERIODS) {
    const value = smas.get(period)![i];
    if (Number.isNaN(value) || value <= price) continue;
    if (!best || value < best.value) best = { period, value };
  }
  return best;
}
