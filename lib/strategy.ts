import type { Candle } from "@/lib/kite";
import { computeSupertrend, computeSMA, toHeikinAshi } from "@/lib/indicators";
import { checkVolumeSpike, type VolumeSpikeCheck } from "@/lib/volumeSpike";
import { checkWaveTrendConfirmation, type WaveTrendCheck } from "@/lib/waveTrend";

const SUPERTREND_PERIOD = 14;
const SUPERTREND_MULTIPLIER = 1;
// SMA10 is excluded as a trigger (too close to price, too noisy) — SMA20 and
// every rung above it are valid triggers.
const SMA_SEQUENCE = [20, 50, 100, 200] as const;

// Enough trading days for SMA200 to warm up plus a safety buffer.
const MIN_CANDLES = 210;

// How many bars back to search for a still-unresolved crossover, not just
// today's. Matches backtestSymbol's own DEFAULT_MAX_HOLD_BARS: a crossover
// older than this wouldn't be treated as an actionable open trade by the
// backtest engine either, so there's no reason the live scanner should keep
// surfacing it indefinitely.
const DEFAULT_MAX_LOOKBACK_BARS = 90;

export type SmaPoint = { period: number; value: number };

export type StrategySignal = {
  direction: "short" | "long";
  // The day the crossover actually happened — NOT necessarily today's date.
  // A signal keeps firing on every day after its trigger day for as long as
  // it stays valid (see below), so this is how a caller can tell how old it
  // is.
  signalDate: string;
  entryPrice: number;
  supertrendValue: number;
  triggerSma: SmaPoint;
  targetSma: SmaPoint;
  // Own-history volume-spike confirmation — see lib/volumeSpike.ts. Checked
  // against the real candles, not entryPrice/supertrendValue/the SMAs above,
  // so it reflects the crossover day's own volume regardless of how many
  // days have passed since.
  volumeSpike: VolumeSpikeCheck;
  // WaveTrend/Market Cipher B-style dot confirmation — see
  // lib/waveTrend.ts. Independent of volumeSpike above; a caller wanting a
  // "both agree" read combines the two itself rather than this type
  // asserting a blended verdict.
  waveTrend: WaveTrendCheck;
};

/**
 * Checks each adjacent pair in the SMA sequence (20->50, 50->100, 100->200)
 * for a crossover of the Supertrend line that is still live today — either
 * it happened on the most recent candle, or it happened up to
 * maxLookbackBars ago and hasn't been invalidated on any day since. A trade
 * doesn't stop being valid just because a few days passed without the setup
 * breaking; it's an actual reversal, not the calendar, that invalidates it.
 * (Before this, the function only ever checked the single latest candle, so
 * a stock would silently disappear from the daily list the day after its
 * crossover even though nothing about the setup had actually changed.)
 *
 * SHORT requires all of, evaluated on the crossover's own day:
 *  - Supertrend "up" (green) on BOTH the crossover day and the day before —
 *    excludes the exact day Supertrend itself flips trend, since its value
 *    jumps to the opposite band on that day rather than moving gradually;
 *    an SMA that happens to already be past the newly-repositioned line
 *    isn't a real crossover, the line jumped past the SMA rather than the
 *    SMA moving across the line (caught via a real case: Kaynes Technology,
 *    where Supertrend's value dropped ~165 points in one bar exactly when
 *    it flipped to an uptrend, and SMA20 — which had been climbing during
 *    the prior rally — ended up numerically above the new, much lower line
 *    without having visibly crossed anything on the chart)
 *  - the Heikin Ashi candle close still above the Supertrend line
 *  - the trigger SMA just crossed from at/below the line to above it
 *  - the target SMA (next rung out) is still below the line — i.e. only the
 *    faster average has caught up to Supertrend, not the slower one yet
 * ...and, evaluated on every day from the crossover through today: Supertrend
 * has stayed "up" AND the trigger SMA has stayed above the Supertrend line.
 * Both matter, not just the Supertrend trend flag — Supertrend can stay
 * "up" (price still above the lower band) while the trigger SMA itself
 * pops above the line for a day or two and then falls back below it, a
 * throwback that isn't a full trend reversal but does mean the specific
 * crossover this signal is based on no longer holds. Checking only the
 * Supertrend flag let a one-day blip from weeks ago keep firing long after
 * the SMA itself had reverted — a real gap, not just a hypothetical one:
 * caught via PAYTM, where SMA20 popped above Supertrend for exactly one day
 * then spent the next three weeks back below it while Supertrend's own
 * trend label never flipped. LONG is the mirror image.
 *
 * Multiple rungs can fire at once; all are returned, at most one crossover
 * per rung (the most recent one that hasn't since been invalidated — an
 * older one behind it would share the same invalidating flip, if any, so
 * there's no need to look further back once one is found). entryPrice,
 * supertrendValue, and both SmaPoints reflect TODAY's values regardless of
 * which day the crossover itself happened on, since those are what's
 * actionable for a decision made today; only signalDate reflects the
 * original trigger day.
 *
 * Supertrend and the SMAs are both computed on Heikin Ashi candles, not real
 * OHLC. This matches how the reference TradingView chart actually plots them:
 * when a chart's candle type is set to Heikin Ashi, TradingView's built-in
 * Supertrend/MA scripts read the HA-transformed open/high/low/close, not the
 * real market prices, unless a script explicitly re-requests raw data. Only
 * entryPrice stays real, since that's the only one of these that's tradeable.
 */
export function detectSignals(
  candles: Candle[],
  maxLookbackBars: number = DEFAULT_MAX_LOOKBACK_BARS
): StrategySignal[] {
  if (candles.length < MIN_CANDLES) return [];

  const heikinAshi = toHeikinAshi(candles);
  const supertrend = computeSupertrend(heikinAshi, SUPERTREND_PERIOD, SUPERTREND_MULTIPLIER);
  const smas = new Map(SMA_SEQUENCE.map((period) => [period, computeSMA(heikinAshi, period)]));

  const i = candles.length - 1;
  const entryPrice = candles[i].close;
  const signals: StrategySignal[] = [];
  const earliestK = Math.max(1, i - maxLookbackBars);

  for (let idx = 0; idx < SMA_SEQUENCE.length - 1; idx++) {
    const period = SMA_SEQUENCE[idx];
    const nextPeriod = SMA_SEQUENCE[idx + 1];
    const series = smas.get(period)!;
    const targetSeries = smas.get(nextPeriod)!;

    for (let k = i; k >= earliestK; k--) {
      const prev = k - 1;
      const curSt = supertrend[k];
      const prevSt = supertrend[prev];
      if (Number.isNaN(curSt.value) || Number.isNaN(prevSt.value)) break; // ran off the front of the indicators' warm-up

      const cur = series[k];
      const prevVal = series[prev];
      const targetValue = targetSeries[k];
      if ([cur, prevVal, targetValue].some(Number.isNaN)) continue;

      const haCloseK = heikinAshi[k].close;

      // Excludes the exact day Supertrend itself flips trend: its value
      // jumps to the opposite band on that day (a discontinuity, not a
      // gradual move), so an SMA that happens to already sit on the far
      // side of the newly-repositioned line isn't a real crossover — the
      // line jumped past the SMA, the SMA didn't cross the line. Requiring
      // the trend to already match on the PREVIOUS day too means the SMA
      // actually had to move across an already-stable, already-established
      // Supertrend line to count.
      const noFlipOnThisBar = prevSt.trend === curSt.trend;

      const shortCross = prevVal <= prevSt.value && cur > curSt.value;
      const targetStillBelowLine = targetValue < curSt.value;
      const isShort =
        shortCross && curSt.trend === "up" && noFlipOnThisBar && haCloseK > curSt.value && targetStillBelowLine;

      const longCross = prevVal >= prevSt.value && cur < curSt.value;
      const targetStillAboveLine = targetValue > curSt.value;
      const isLong =
        longCross && curSt.trend === "down" && noFlipOnThisBar && haCloseK < curSt.value && targetStillAboveLine;

      if (!isShort && !isLong) continue;

      const direction: "short" | "long" = isShort ? "short" : "long";
      let stillLive = true;
      for (let j = k; j <= i; j++) {
        const stJ = supertrend[j];
        const smaJ = series[j];
        const trendOk = stJ.trend === (direction === "short" ? "up" : "down");
        const smaOnCorrectSide = direction === "short" ? smaJ > stJ.value : smaJ < stJ.value;
        if (!trendOk || Number.isNaN(smaJ) || !smaOnCorrectSide) {
          stillLive = false;
          break;
        }
      }

      if (stillLive) {
        const curSma = series[i];
        const curTarget = targetSeries[i];
        if (![curSma, curTarget].some(Number.isNaN)) {
          signals.push({
            direction,
            signalDate: candles[k].date,
            entryPrice,
            supertrendValue: supertrend[i].value,
            triggerSma: { period, value: curSma },
            targetSma: { period: nextPeriod, value: curTarget },
            volumeSpike: checkVolumeSpike(candles, k),
            waveTrend: checkWaveTrendConfirmation(candles, k, direction),
          });
        }
      }
      break; // this rung's most recent qualifying crossover has been resolved either way — no need to look further back
    }
  }

  return signals;
}
