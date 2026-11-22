import type { Candle } from "@/lib/kite";

// "3/4 days" — the recent window checked for unusual buildup.
const RECENT_DAYS = 4;
// "Last 3 months daily avg" — ~21 trading days/month.
const BASELINE_TRADING_DAYS = 63;
// "At least double."
const ACCUMULATION_RATIO = 2;

export type FuturesVolumeCheck = {
  status: "confirmed" | "not_confirmed";
  recentAvgVolume: number;
  baselineAvgVolume: number;
  ratio: number; // recentAvgVolume / baselineAvgVolume
};

/**
 * Checks for unusual FUTURES volume buildup — "whales accumulating" per the
 * request — on a stock's own near-month futures contract, not its cash/
 * equity volume (that's lib/volumeSpike.ts's own, separate check, used by
 * the main Strategy tab and Strategy Tab 2). Confirmed when the trailing
 * RECENT_DAYS average volume is at least ACCUMULATION_RATIO times the
 * BASELINE_TRADING_DAYS ("last 3 months") average — a sustained few-day
 * buildup relative to the contract's own longer-run normal, not a single
 * day's spike (lib/volumeSpike.ts already covers that shape of check, on
 * cash volume).
 *
 * The baseline window is the BASELINE_TRADING_DAYS immediately BEFORE the
 * recent window, excluding the recent days themselves — same reasoning as
 * lib/volumeSpike.ts's trailingVolumeAvg: a baseline that included the
 * recent buildup would inflate the very average the buildup is being
 * measured against, understating how unusual it actually is.
 *
 * Returns null (not a false negative) when there isn't yet enough futures
 * history to compute a trustworthy baseline — a near-month contract is
 * itself only listed ~3 months before its own expiry, so this can
 * genuinely happen for a contract that recently rolled into "near month."
 */
export function checkFuturesVolumeAccumulation(futuresCandles: Candle[]): FuturesVolumeCheck | null {
  if (futuresCandles.length < BASELINE_TRADING_DAYS + RECENT_DAYS) return null;

  const recent = futuresCandles.slice(-RECENT_DAYS);
  const recentAvgVolume = recent.reduce((sum, c) => sum + c.volume, 0) / RECENT_DAYS;

  const baseline = futuresCandles.slice(-(BASELINE_TRADING_DAYS + RECENT_DAYS), -RECENT_DAYS);
  const baselineAvgVolume = baseline.reduce((sum, c) => sum + c.volume, 0) / baseline.length;

  const ratio = baselineAvgVolume > 0 ? recentAvgVolume / baselineAvgVolume : 0;

  return {
    status: ratio >= ACCUMULATION_RATIO ? "confirmed" : "not_confirmed",
    recentAvgVolume,
    baselineAvgVolume,
    ratio,
  };
}
