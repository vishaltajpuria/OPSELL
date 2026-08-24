import type { Candle } from "@/lib/kite";
import { computeSupertrend, computeRSI, smaSeries } from "@/lib/indicators";
import type { BacktestTrade } from "@/lib/backtest";

// Parameters as given in the source Pine script ("RSI & SuperTrend Özel Dip
// Stratejisi") — hardcoded to match it exactly rather than exposed as UI
// knobs, since the request was to run this specific strategy, not a
// parameterized family of it.
const RSI_LENGTH = 10;
const SIGNAL_LENGTH = 10; // SMA of RSI — the line RSI crosses
const TRIGGER_LEVEL = 50; // crossovers only count while RSI is below this
const TARGET_CROSS_COUNT = 2; // "double dip" — the 2nd qualifying cross fires the entry
const SUPERTREND_PERIOD = 10;
const SUPERTREND_MULTIPLIER = 2.5;

const MIN_CANDLES = 40; // RSI(10) + its own SMA(10) warm-up, plus a safety buffer
const DEFAULT_MAX_HOLD_BARS = 90; // same open-trade safety net as backtestSymbol

export type RsiDipBacktestOptions = {
  // Not part of the source script (which has no stop) — offered for parity
  // with the SMA/Supertrend backtest's stop-loss knob. Omitted = no stop,
  // matching the script's actual behavior (Supertrend-flip is the only exit).
  stopLossPercent?: number;
  maxHoldBars?: number;
};

/**
 * Walk-forward backtest of a "double RSI dip" strategy (long only): RSI(10)
 * crossing over its own 10-period SMA counts as a qualifying "dip" whenever
 * it happens with RSI still below 50 (a failed rally attempt while still
 * bearish); RSI rising back above 50 resets the counter to zero. The 2nd
 * such crossover (a double-bottom / "W" shape in the oscillator) fires a
 * long entry. The position is closed on the first bar Supertrend(10, 2.5)
 * transitions from an uptrend to a downtrend — a single-bar transition
 * event, not "whenever it's in a downtrend" — matching the source script's
 * `ta.change(direction) > 0` exit exactly. Computed on real OHLC candles;
 * unlike the SMA/Supertrend strategy, this script never requests Heikin Ashi.
 *
 * Entry is the next bar's open after the signal bar (only knowable once
 * that bar closes, same convention as backtestSymbol). Only one trade open
 * at a time per symbol — the crossover counter itself still runs every bar
 * regardless of position state, matching the source script (the counter is
 * plain indicator logic, not gated by strategy.position).
 */
export function backtestRsiDip(
  symbol: string,
  candles: Candle[],
  options: RsiDipBacktestOptions = {}
): BacktestTrade[] {
  const stopLossPercent = options.stopLossPercent && options.stopLossPercent > 0 ? options.stopLossPercent : null;
  const maxHoldBars = options.maxHoldBars && options.maxHoldBars > 0 ? options.maxHoldBars : DEFAULT_MAX_HOLD_BARS;
  if (candles.length < MIN_CANDLES) return [];

  const rsi = computeRSI(candles, RSI_LENGTH);
  const rsiSignal = smaSeries(rsi, SIGNAL_LENGTH);
  const supertrend = computeSupertrend(candles, SUPERTREND_PERIOD, SUPERTREND_MULTIPLIER);

  const trades: BacktestTrade[] = [];
  let openUntilIndex = -1;
  let crossCount = 0;

  for (let i = 1; i < candles.length; i++) {
    const curRsi = rsi[i];
    const curSig = rsiSignal[i];
    const prevRsi = rsi[i - 1];
    const prevSig = rsiSignal[i - 1];
    if ([curRsi, curSig, prevRsi, prevSig].some(Number.isNaN)) continue;

    // Counter bookkeeping runs every bar regardless of whether a trade is
    // open — it's plain indicator state in the source script, not gated by
    // strategy position.
    if (curRsi > TRIGGER_LEVEL) crossCount = 0;
    const bullCross = prevRsi <= prevSig && curRsi > curSig;
    if (bullCross && curRsi < TRIGGER_LEVEL) crossCount++;
    const specialBuy = bullCross && curRsi < TRIGGER_LEVEL && crossCount === TARGET_CROSS_COUNT;
    if (specialBuy) crossCount = 0;

    if (i <= openUntilIndex) continue; // already in a trade — don't take a new one
    if (!specialBuy) continue;

    const entryIndex = i + 1;
    if (entryIndex >= candles.length) {
      trades.push({
        symbol,
        direction: "long",
        label: "RSI Double Dip",
        signalDate: candles[i].date,
        entryDate: candles[i].date,
        entryPrice: candles[i].close,
        exitDate: null,
        exitPrice: null,
        exitReason: "no_next_candle",
        pnlPercent: null,
        holdDays: null,
      });
      continue;
    }

    const entryPrice = candles[entryIndex].open;
    const entryDate = candles[entryIndex].date;
    const stopLossPrice = stopLossPercent ? entryPrice * (1 - stopLossPercent / 100) : null;

    let exitIndex: number | null = null;
    let exitReason: BacktestTrade["exitReason"] = "open";
    const maxJ = Math.min(candles.length - 1, entryIndex + maxHoldBars);

    for (let j = entryIndex; j <= maxJ; j++) {
      if (stopLossPrice !== null && candles[j].low <= stopLossPrice) {
        exitIndex = j;
        exitReason = "stop_loss";
        break;
      }
      // Exit exactly on the up->down transition bar, not merely "while in a
      // downtrend" — see the docstring above for why that distinction matters.
      if (supertrend[j].trend === "down" && supertrend[j - 1].trend === "up") {
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
      exitPrice = exitReason === "stop_loss" ? (stopLossPrice as number) : candles[exitIndex].close;
      pnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100;
      holdDays = exitIndex - entryIndex;
      openUntilIndex = exitIndex;
    } else {
      openUntilIndex = maxJ;
    }

    trades.push({
      symbol,
      direction: "long",
      label: "RSI Double Dip",
      signalDate: candles[i].date,
      entryDate,
      entryPrice,
      exitDate,
      exitPrice,
      exitReason,
      pnlPercent,
      holdDays,
    });
  }

  return trades;
}
