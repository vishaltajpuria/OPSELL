import type { Candle } from "@/lib/kite";
import { toHeikinAshi, computeSupertrend, resampleTo4H } from "@/lib/indicators";

// Same period/multiplier as the main strategy's own Supertrend (lib/strategy.ts)
// — this is the same indicator, just checked as a standalone read on the 4H
// timeframe rather than as a crossover trigger.
const SUPERTREND_PERIOD = 14;
const SUPERTREND_MULTIPLIER = 1;

// Comfortable warm-up margin beyond the ATR period itself, in 4H BARS (not
// calendar days) — Wilder's smoothed ATR settles gradually, so a handful of
// bars past the raw period minimum still isn't a stable read.
const MIN_4H_BARS = 30;

/**
 * Whether price is currently below the 4H Supertrend line — the same
 * "down" trend flag lib/strategy.ts's own crossover detection reads,
 * just checked directly on the latest bar rather than as part of a
 * crossover. Computed on Heikin Ashi 4H candles (resampled from 60-minute —
 * see resampleTo4H), matching how the main strategy computes Supertrend
 * everywhere else in this app.
 *
 * Returns null (not false) when there isn't enough 4H history yet to trust
 * the read — a freshly-listed instrument or a short candle fetch — so a
 * caller can tell "not below" from "unknown" rather than conflating them.
 */
export function isBelowFourHourSupertrend(hourlyCandles: Candle[]): boolean | null {
  const fourHour = resampleTo4H(hourlyCandles);
  if (fourHour.length < MIN_4H_BARS) return null;

  const heikinAshi = toHeikinAshi(fourHour);
  const supertrend = computeSupertrend(heikinAshi, SUPERTREND_PERIOD, SUPERTREND_MULTIPLIER);
  const last = supertrend[supertrend.length - 1];
  if (Number.isNaN(last.value)) return null;

  return last.trend === "down";
}
