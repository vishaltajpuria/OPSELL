import type { Candle } from "@/lib/kite";
import { toHeikinAshi, computeSupertrend, resampleToWeekly } from "@/lib/indicators";

// Same period/multiplier as the main strategy's own Supertrend
// (lib/strategy.ts), lib/fourHourSupertrend.ts's 4H read, and
// lib/dailySupertrend.ts's daily read — this is the same indicator, just
// checked as a standalone read on the WEEKLY timeframe rather than as a
// crossover trigger.
const SUPERTREND_PERIOD = 14;
const SUPERTREND_MULTIPLIER = 1;

// Comfortable warm-up margin beyond the ATR period itself, in WEEKLY bars
// (not calendar days) — same reasoning as MIN_4H_BARS in
// lib/fourHourSupertrend.ts, just scaled to this timeframe.
const MIN_WEEKLY_BARS = 20;

/**
 * The current WEEKLY Supertrend trend ("up" = price above the line, "down"
 * = below it) — same trend flag as lib/dailySupertrend.ts's daily read and
 * lib/fourHourSupertrend.ts's 4H read, just resampled to weekly bars (see
 * resampleToWeekly) — the same resample lib/wtStrategy.ts's own
 * weeklyWtBreach check already uses, so this needs no separate candle
 * fetch either: it runs directly on whatever daily candles the caller
 * already has.
 *
 * Returns null when there isn't enough weekly history yet for a valid ATR
 * read. Which side of this a caller treats as noteworthy is
 * direction-dependent (see app/strategy2/page.tsx's BW/AW ticks — "down"
 * is the flag for a long signal, "up" for a short one), so this returns
 * the raw trend rather than pre-baking a direction into it.
 */
export function getWeeklySupertrendTrend(dailyCandles: Candle[]): "up" | "down" | null {
  const weekly = resampleToWeekly(dailyCandles);
  if (weekly.length < MIN_WEEKLY_BARS) return null;

  const heikinAshi = toHeikinAshi(weekly);
  const supertrend = computeSupertrend(heikinAshi, SUPERTREND_PERIOD, SUPERTREND_MULTIPLIER);
  const last = supertrend[supertrend.length - 1];
  if (Number.isNaN(last.value)) return null;

  return last.trend;
}
