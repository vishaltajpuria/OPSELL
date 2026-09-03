import type { Candle } from "@/lib/kite";
import { toHeikinAshi, computeSupertrend, computeSMA } from "@/lib/indicators";
import { checkVolumeSpike, type VolumeSpikeCheck } from "@/lib/volumeSpike";
import { checkWaveTrendConfirmation, type WaveTrendCheck } from "@/lib/waveTrend";

const SUPERTREND_PERIOD = 14;
const SUPERTREND_MULTIPLIER = 1;
const SMA_SEQUENCE = [20, 50, 100, 200] as const;
const MIN_CANDLES = 210;

// Trades still unresolved this many BARS after entry are marked "open"
// rather than forced closed — long enough on the daily timeframe that most
// real trades will have hit their target or been invalidated well before
// this. Bars, not calendar days: on an intraday timeframe (4H/2H) the same
// bar count covers proportionally less calendar time, so callers backtesting
// those pass a scaled-up maxHoldBars (see BacktestOptions) rather than
// leaving this as an implicit "90 days" that would quietly become "90 bars
// = ~45 days" on 4H or "~22 days" on 2H.
const DEFAULT_MAX_HOLD_BARS = 90;

export type BacktestTrade = {
  symbol: string;
  direction: "short" | "long";
  label: string; // "Short" | "Super Short" | "Long" | "Super Long"
  signalDate: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string | null;
  exitPrice: number | null;
  exitReason: "target" | "stop_loss" | "invalidated" | "open" | "no_next_candle";
  pnlPercent: number | null;
  holdDays: number | null;
  // Own-history volume-spike confirmation on the signal day — see
  // lib/volumeSpike.ts. Populated by backtestSymbol (the SMA/Supertrend
  // reversal strategy this was built for); left undefined by
  // backtestRsiDip, a different strategy this check was never asked to
  // cover. Otherwise always fully resolved here (never "pending") except
  // for a signal within SPIKE_WINDOW_DAYS of the end of the fetched candle
  // history, where the 10-day window hasn't played out in the data yet.
  volumeSpike?: VolumeSpikeCheck;
  // WaveTrend/Market Cipher B-style dot confirmation — see lib/waveTrend.ts.
  // Same populated-by-backtestSymbol-only caveat as volumeSpike above.
  waveTrend?: WaveTrendCheck;
};

export type BacktestOptions = {
  // Fixed % move against the entry price that closes the trade regardless
  // of target/Supertrend state — e.g. 3 for a 3% stop. Omitted/0 = no stop,
  // matching the original behavior where only the target and a Supertrend
  // flip can end a trade.
  stopLossPercent?: number;
  // Restrict signal detection to one direction — e.g. "short" to backtest
  // only Short/Super Short setups. The other direction's signals aren't
  // just excluded from the results, they're skipped entirely during
  // detection, so they never occupy the one-trade-per-stock slot either
  // (a long signal you're not taking shouldn't block a later short one).
  // Omitted = both directions, matching the original behavior.
  directionFilter?: "short" | "long";
  // Bars (not calendar days) after which an unresolved trade is forced to
  // "open" — see DEFAULT_MAX_HOLD_BARS. Pass a scaled-up value on intraday
  // timeframes so the real-time window stays consistent with the daily
  // default of ~90 trading days.
  maxHoldBars?: number;
};

function signalLabel(direction: "short" | "long", triggerPeriod: number): string {
  const base = direction === "short" ? "Short" : "Long";
  const isSuper = triggerPeriod === 50 || triggerPeriod === 100;
  return isSuper ? `Super ${base}` : base;
}

/**
 * Walk-forward backtest of the same crossover logic as lib/strategy.ts's
 * detectSignals, but for every historical day instead of just the latest
 * one, and simulating each trade forward to a realistic exit rather than
 * just reporting the entry.
 *
 * Indicators are computed once over the whole series (safe: Supertrend/SMA
 * at index i only ever depend on candles[0..i], so this produces the exact
 * same values detectSignals would get calling it fresh each day — no
 * lookahead bias).
 *
 * Simulation rules (not specified by the strategy itself, since it's meant
 * to be traded on discretion — documented here so they're easy to
 * question/adjust):
 *  - Entry is the NEXT day's open after the signal day, since the signal
 *    itself is only knowable once that day's candle has closed.
 *  - The target is the target SMA's CURRENT value on each day going
 *    forward, not a level frozen at entry — it moves as the SMA does. A
 *    trade exits the first day the target is actually touched (checked
 *    against that day's low for a short, high for a long).
 *  - If a stopLossPercent is given, a fixed price stop is checked FIRST each
 *    day (against that day's high for a short, low for a long) — since a
 *    day's OHLC alone doesn't say whether the high or low came first, this
 *    is the conservative assumption: if both the stop and something more
 *    favorable are technically touched on the same day, the stop wins.
 *  - If the stop isn't hit and the target isn't touched, the trade is
 *    invalidated (and closed at that day's close) the first day Supertrend
 *    flips against the position — that's the strategy's own signal that the
 *    setup has broken, so it doubles as a second, unbounded stop-loss rule
 *    when no fixed one is given.
 *  - Only one trade per stock at a time: while a trade is open, later
 *    signals on the same stock are ignored until it exits.
 *  - A trade still neither hit nor invalidated after maxHoldBars bars (90 by
 *    default — see BacktestOptions), or still running when the data runs
 *    out, is marked "open" (not counted as a win or loss).
 */
export function backtestSymbol(symbol: string, candles: Candle[], options: BacktestOptions = {}): BacktestTrade[] {
  const stopLossPercent = options.stopLossPercent && options.stopLossPercent > 0 ? options.stopLossPercent : null;
  const directionFilter = options.directionFilter ?? null;
  const maxHoldBars = options.maxHoldBars && options.maxHoldBars > 0 ? options.maxHoldBars : DEFAULT_MAX_HOLD_BARS;
  if (candles.length < MIN_CANDLES) return [];

  const heikinAshi = toHeikinAshi(candles);
  const supertrend = computeSupertrend(heikinAshi, SUPERTREND_PERIOD, SUPERTREND_MULTIPLIER);
  const smas = new Map(SMA_SEQUENCE.map((period) => [period, computeSMA(heikinAshi, period)]));

  const trades: BacktestTrade[] = [];
  let openUntilIndex = -1;

  for (let i = MIN_CANDLES; i < candles.length; i++) {
    if (i <= openUntilIndex) continue;

    const prev = i - 1;
    const curSt = supertrend[i];
    const prevSt = supertrend[prev];
    if (Number.isNaN(curSt.value) || Number.isNaN(prevSt.value)) continue;
    const haClose = heikinAshi[i].close;

    for (let idx = 0; idx < SMA_SEQUENCE.length - 1; idx++) {
      const period = SMA_SEQUENCE[idx];
      const nextPeriod = SMA_SEQUENCE[idx + 1];
      const series = smas.get(period)!;
      const targetSeries = smas.get(nextPeriod)!;

      const cur = series[i];
      const prevVal = series[prev];
      const targetValue = targetSeries[i];
      if ([cur, prevVal, targetValue].some(Number.isNaN)) continue;

      // Excludes the exact day Supertrend itself flips trend — its value
      // jumps to the opposite band that day rather than moving gradually,
      // so an SMA that happens to already sit past the newly-repositioned
      // line isn't a real crossover (the line jumped past the SMA, not the
      // other way around). See lib/strategy.ts's detectSignals for the full
      // explanation — same fix, same underlying artifact, since this loop
      // uses identical crossover logic and would otherwise generate the
      // same spurious trades in backtest results.
      const noFlipOnThisBar = prevSt.trend === curSt.trend;

      const shortCross = prevVal <= prevSt.value && cur > curSt.value;
      const targetStillBelowLine = targetValue < curSt.value;
      const longCross = prevVal >= prevSt.value && cur < curSt.value;
      const targetStillAboveLine = targetValue > curSt.value;

      let direction: "short" | "long" | null = null;
      if (shortCross && curSt.trend === "up" && noFlipOnThisBar && haClose > curSt.value && targetStillBelowLine) {
        direction = "short";
      } else if (
        longCross &&
        curSt.trend === "down" &&
        noFlipOnThisBar &&
        haClose < curSt.value &&
        targetStillAboveLine
      ) {
        direction = "long";
      }
      if (!direction) continue;
      if (directionFilter && direction !== directionFilter) continue;

      const entryIndex = i + 1;
      if (entryIndex >= candles.length) {
        // Signal fired on the last available day — nothing to enter into yet.
        trades.push({
          symbol,
          direction,
          label: signalLabel(direction, period),
          signalDate: candles[i].date,
          entryDate: candles[i].date,
          entryPrice: candles[i].close,
          exitDate: null,
          exitPrice: null,
          exitReason: "no_next_candle",
          pnlPercent: null,
          holdDays: null,
          volumeSpike: checkVolumeSpike(candles, i),
          waveTrend: checkWaveTrendConfirmation(candles, i, direction),
        });
        break;
      }

      const entryPrice = candles[entryIndex].open;
      const entryDate = candles[entryIndex].date;
      const stopLossPrice = stopLossPercent
        ? direction === "short"
          ? entryPrice * (1 + stopLossPercent / 100)
          : entryPrice * (1 - stopLossPercent / 100)
        : null;

      let exitIndex: number | null = null;
      let exitReason: BacktestTrade["exitReason"] = "open";
      const maxJ = Math.min(candles.length - 1, entryIndex + maxHoldBars);

      for (let j = entryIndex; j <= maxJ; j++) {
        if (stopLossPrice !== null) {
          const hitStop = direction === "short" ? candles[j].high >= stopLossPrice : candles[j].low <= stopLossPrice;
          if (hitStop) {
            exitIndex = j;
            exitReason = "stop_loss";
            break;
          }
        }

        const targetNow = targetSeries[j];
        if (!Number.isNaN(targetNow)) {
          const touchedTarget = direction === "short" ? candles[j].low <= targetNow : candles[j].high >= targetNow;
          if (touchedTarget) {
            exitIndex = j;
            exitReason = "target";
            break;
          }
        }

        const flippedAgainst = direction === "short" ? supertrend[j].trend === "down" : supertrend[j].trend === "up";
        if (flippedAgainst) {
          exitIndex = j;
          exitReason = "invalidated";
          break;
        }
      }

      let exitDate: string | null = null;
      let exitPrice: number | null = null;
      let pnlPercent: number | null = null;
      let holdDays: number | null = null;

      if (exitIndex !== null) {
        exitDate = candles[exitIndex].date;
        exitPrice =
          exitReason === "target"
            ? targetSeries[exitIndex]
            : exitReason === "stop_loss"
              ? (stopLossPrice as number)
              : candles[exitIndex].close;
        pnlPercent =
          direction === "short"
            ? ((entryPrice - exitPrice) / entryPrice) * 100
            : ((exitPrice - entryPrice) / entryPrice) * 100;
        holdDays = exitIndex - entryIndex;
        openUntilIndex = exitIndex;
      } else {
        openUntilIndex = maxJ;
      }

      trades.push({
        symbol,
        direction,
        label: signalLabel(direction, period),
        signalDate: candles[i].date,
        entryDate,
        entryPrice,
        exitDate,
        exitPrice,
        exitReason,
        pnlPercent,
        holdDays,
        volumeSpike: checkVolumeSpike(candles, i),
        waveTrend: checkWaveTrendConfirmation(candles, i, direction),
      });

      break; // one entry per signal day, even if multiple SMA rungs qualify
    }
  }

  return trades;
}
