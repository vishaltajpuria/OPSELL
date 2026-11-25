import type { Candle } from "@/lib/kite";
import { toHeikinAshi, computeSupertrend, resampleTo4H, supertrendStreak, type SupertrendStreak } from "@/lib/indicators";

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
 * The current 4H Supertrend trend AND how many 4H bars, ending at the
 * latest one, it's held unbroken (see supertrendStreak in
 * lib/indicators.ts) — used by Strategy Tab 3's B4H/A4H streak-length
 * ranking (app/strategy3/page.tsx) as well as its own tick. Computed on
 * Heikin Ashi 4H candles (resampled from 60-minute — see resampleTo4H),
 * matching how the main strategy computes Supertrend everywhere else in
 * this app.
 *
 * Returns null when there isn't enough 4H history yet to trust the read —
 * a freshly-listed instrument or a short candle fetch.
 */
export function getFourHourSupertrendStreak(hourlyCandles: Candle[]): SupertrendStreak | null {
  const fourHour = resampleTo4H(hourlyCandles);
  if (fourHour.length < MIN_4H_BARS) return null;

  const heikinAshi = toHeikinAshi(fourHour);
  const supertrend = computeSupertrend(heikinAshi, SUPERTREND_PERIOD, SUPERTREND_MULTIPLIER);
  return supertrendStreak(supertrend);
}

/**
 * Just the trend side of getFourHourSupertrendStreak above, for callers
 * that only need "up"/"down"/null and not the streak length (Strategy Tab
 * 2's B4H/A4H tick — see app/strategy2/page.tsx). Which side of this a
 * caller treats as noteworthy is direction-dependent (there, "down" is the
 * flag for a long signal, "up" for a short one), so this returns the raw
 * trend rather than pre-baking a direction into it.
 */
export function getFourHourSupertrendTrend(hourlyCandles: Candle[]): "up" | "down" | null {
  return getFourHourSupertrendStreak(hourlyCandles)?.trend ?? null;
}
