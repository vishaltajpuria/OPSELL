import type { Candle } from "@/lib/kite";
import { toHeikinAshi, computeSupertrend, supertrendStreak, type SupertrendStreak } from "@/lib/indicators";

// Same period/multiplier as the main strategy's own Supertrend
// (lib/strategy.ts) and lib/fourHourSupertrend.ts's 4H read — this is the
// same indicator, just checked as a standalone read on the DAILY timeframe
// rather than as a crossover trigger.
const SUPERTREND_PERIOD = 14;
const SUPERTREND_MULTIPLIER = 1;

/**
 * The current DAILY Supertrend trend AND how many daily candles, ending
 * today, it's held unbroken (see supertrendStreak in lib/indicators.ts) —
 * used by Strategy Tab 3's BD/AD streak-length ranking
 * (app/strategy3/page.tsx) as well as its own tick. Computed on Heikin Ashi
 * daily candles, matching how the main strategy computes Supertrend
 * everywhere else in this app.
 *
 * Unlike lib/fourHourSupertrend.ts's 4H read, this needs no separate candle
 * fetch or resample — it runs directly on whatever daily candles the
 * caller already has (the same ones detectWtSignals uses for WT itself),
 * so it's always as cheap as a few more lines of arithmetic.
 *
 * Returns null when there isn't enough daily history yet for a valid ATR
 * read.
 */
export function getDailySupertrendStreak(candles: Candle[]): SupertrendStreak | null {
  if (candles.length === 0) return null;
  const heikinAshi = toHeikinAshi(candles);
  const supertrend = computeSupertrend(heikinAshi, SUPERTREND_PERIOD, SUPERTREND_MULTIPLIER);
  return supertrendStreak(supertrend);
}

/**
 * Just the trend side of getDailySupertrendStreak above, for callers that
 * only need "up"/"down"/null and not the streak length (Strategy Tab 2's
 * BD/AD tick — see app/strategy2/page.tsx). Which side of this a caller
 * treats as noteworthy is direction-dependent (there, "down" is the flag
 * for a long signal, "up" for a short one), so this returns the raw trend
 * rather than pre-baking a direction into it.
 */
export function getDailySupertrendTrend(candles: Candle[]): "up" | "down" | null {
  return getDailySupertrendStreak(candles)?.trend ?? null;
}
