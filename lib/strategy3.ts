import type { Candle } from "@/lib/kite";
import { getDailySupertrendStreak } from "@/lib/dailySupertrend";
import { getWeeklySupertrendStreak } from "@/lib/weeklySupertrend";
import type { SupertrendStreak } from "@/lib/indicators";
import { findNextGap, type GapInfo } from "@/lib/gaps";
import type { FuturesVolumeCheck } from "@/lib/futuresVolume";

export type Strategy3Signal = {
  // "long" = below the Supertrend line on ALL THREE timeframes at once
  // (weekly, daily, 4H) — a stock beaten down across every scale, the
  // mean-reversion-long read. "short" is the mirror: ABOVE the line on all
  // three — extended higher across every scale, the mean-reversion-short
  // read. WaveTrend plays no part in this gate at all, unlike Strategy Tab
  // 2 ("no matter if wt is anywhere" per the request) — this tab is purely
  // the triple-timeframe Supertrend alignment.
  direction: "long" | "short";
  entryPrice: number; // today's close
  // How many bars, ending now, each timeframe's trend has held unbroken —
  // weekly/daily bars for those two, 4H bars for the third (see
  // supertrendStreak in lib/indicators.ts). Used by app/strategy3/page.tsx
  // both for its BW/BD/B4H (or AW/AD/A4H) streak-length tick labels and
  // for ranking: weekly streak length decides first, daily second, 4H
  // third, per the request ("a stock which has been below weekly
  // supertrend max will show on top... after that daily and 4H will be
  // given importance").
  weeklyStreakBars: number;
  dailyStreakBars: number;
  fourHourStreakBars: number;
  // Nearest still-unfilled real (non-Heikin-Ashi) price gap on EACH side —
  // unlike Strategy Tab 2's single direction-matched nextGap, this tab
  // shows both regardless of direction, since it's a broad tracking list
  // rather than a directional entry signal — see findNextGap in
  // lib/gaps.ts.
  gapUp: GapInfo | null;
  gapDown: GapInfo | null;
  // Futures volume accumulation check ("whales accumulating") — see
  // lib/futuresVolume.ts. Resolved asynchronously from the stock's own
  // near-month futures contract, separately from this synchronous
  // detection (same reasoning as atmOption on StoredStrategy3Signal in
  // lib/kv.ts), so it isn't set here.
  volumeAccumulation?: FuturesVolumeCheck | null;
};

/**
 * Strategy Tab 3's own entry gate — standalone, independent of both the
 * main Supertrend/SMA crossover strategy (lib/strategy.ts) and Strategy Tab
 * 2's WaveTrend gate (lib/wtStrategy.ts). A stock qualifies only when its
 * Supertrend trend agrees across ALL THREE timeframes simultaneously:
 * weekly, daily, and 4H. A stock with a mixed read across timeframes (e.g.
 * below daily but still above weekly) doesn't qualify in either direction.
 *
 * fourHourStreak is passed in rather than computed here because it needs
 * its own 60-minute candle fetch (see lib/fourHourSupertrend.ts) — an
 * async step the caller (lib/runStrategy3.ts) already has to do
 * regardless, so this function stays a plain synchronous check over
 * whatever the caller already resolved.
 *
 * Returns null if any of the three timeframes isn't warmed up yet (the
 * daily/weekly streak reads or fourHourStreak are all null in that case)
 * or if the three timeframes don't actually agree — not a signal either
 * way.
 */
export function detectStrategy3Signal(
  dailyCandles: Candle[],
  fourHourStreak: SupertrendStreak | null
): Strategy3Signal | null {
  if (dailyCandles.length === 0 || fourHourStreak === null) return null;

  const dailyStreak = getDailySupertrendStreak(dailyCandles);
  const weeklyStreak = getWeeklySupertrendStreak(dailyCandles);
  if (dailyStreak === null || weeklyStreak === null) return null;

  let direction: "long" | "short" | null = null;
  if (dailyStreak.trend === "down" && weeklyStreak.trend === "down" && fourHourStreak.trend === "down") {
    direction = "long";
  } else if (dailyStreak.trend === "up" && weeklyStreak.trend === "up" && fourHourStreak.trend === "up") {
    direction = "short";
  }
  if (!direction) return null;

  const entryPrice = dailyCandles[dailyCandles.length - 1].close;
  return {
    direction,
    entryPrice,
    weeklyStreakBars: weeklyStreak.bars,
    dailyStreakBars: dailyStreak.bars,
    fourHourStreakBars: fourHourStreak.bars,
    gapUp: findNextGap(dailyCandles, entryPrice, 20, "up"),
    gapDown: findNextGap(dailyCandles, entryPrice, 20, "down"),
  };
}
