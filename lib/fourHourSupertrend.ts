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
 * The current 4H Supertrend trend ("up" = price above the line, "down" =
 * below it) — the same trend flag lib/strategy.ts's own crossover
 * detection reads, just checked directly on the latest bar rather than as
 * part of a crossover. Computed on Heikin Ashi 4H candles (resampled from
 * 60-minute — see resampleTo4H), matching how the main strategy computes
 * Supertrend everywhere else in this app.
 *
 * Returns null when there isn't enough 4H history yet to trust the read —
 * a freshly-listed instrument or a short candle fetch — so a caller can
 * tell "unknown" apart from either real trend value. Which side of this a
 * caller treats as noteworthy is direction-dependent (see
 * app/strategy2/page.tsx's B4H/A4H ticks — "down" is the flag for a long
 * signal, "up" for a short one), so this returns the raw trend rather than
 * pre-baking a direction into it.
 */
export function getFourHourSupertrendTrend(hourlyCandles: Candle[]): "up" | "down" | null {
  const fourHour = resampleTo4H(hourlyCandles);
  if (fourHour.length < MIN_4H_BARS) return null;

  const heikinAshi = toHeikinAshi(fourHour);
  const supertrend = computeSupertrend(heikinAshi, SUPERTREND_PERIOD, SUPERTREND_MULTIPLIER);
  const last = supertrend[supertrend.length - 1];
  if (Number.isNaN(last.value)) return null;

  return last.trend;
}
