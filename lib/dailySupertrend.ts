import type { Candle } from "@/lib/kite";
import { toHeikinAshi, computeSupertrend } from "@/lib/indicators";

// Same period/multiplier as the main strategy's own Supertrend
// (lib/strategy.ts) and lib/fourHourSupertrend.ts's 4H read — this is the
// same indicator, just checked as a standalone read on the DAILY timeframe
// rather than as a crossover trigger.
const SUPERTREND_PERIOD = 14;
const SUPERTREND_MULTIPLIER = 1;

/**
 * The current DAILY Supertrend trend ("up" = price above the line, "down"
 * = below it) — the same trend flag lib/strategy.ts's own crossover
 * detection reads, just checked directly on the latest bar rather than as
 * part of a crossover, and entirely independent of that strategy's SMA
 * crossover logic. Computed on Heikin Ashi daily candles, matching how the
 * main strategy computes Supertrend everywhere else in this app.
 *
 * Unlike lib/fourHourSupertrend.ts's 4H read, this needs no separate candle
 * fetch or resample — it runs directly on whatever daily candles the
 * caller already has (the same ones detectWtSignals uses for WT itself),
 * so it's always as cheap as a few more lines of arithmetic.
 *
 * Returns null when there isn't enough daily history yet for a valid ATR
 * read. Which side of this a caller treats as noteworthy is
 * direction-dependent (see app/strategy2/page.tsx's BD/AD ticks — "down"
 * is the flag for a long signal, "up" for a short one), so this returns
 * the raw trend rather than pre-baking a direction into it.
 */
export function getDailySupertrendTrend(candles: Candle[]): "up" | "down" | null {
  if (candles.length === 0) return null;
  const heikinAshi = toHeikinAshi(candles);
  const supertrend = computeSupertrend(heikinAshi, SUPERTREND_PERIOD, SUPERTREND_MULTIPLIER);
  const last = supertrend[supertrend.length - 1];
  if (Number.isNaN(last.value)) return null;
  return last.trend;
}
