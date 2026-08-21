import type { Candle } from "@/lib/kite";
import { toHeikinAshi, computeSupertrend, computeSMA } from "@/lib/indicators";

const SUPERTREND_PERIOD = 14;
const SUPERTREND_MULTIPLIER = 1;
const SMA_SEQUENCE = [20, 50, 100, 200] as const;
const MIN_CANDLES = 210;

// Trades still unresolved this long after entry are marked "open" rather
// than forced closed — long enough that most real trades will have hit
// their target or been invalidated well before this.
const MAX_HOLD_DAYS = 90;

export type BacktestTrade = {
  symbol: string;
  direction: "short" | "long";
  label: string; // "Short" | "Super Short" | "Long" | "Super Long"
  signalDate: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string | null;
  exitPrice: number | null;
  exitReason: "target" | "invalidated" | "open" | "no_next_candle";
  pnlPercent: number | null;
  holdDays: number | null;
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
 *  - If the target isn't touched, the trade is invalidated (and closed at
 *    that day's close) the first day Supertrend flips against the position
 *    — that's the strategy's own signal that the setup has broken, so it
 *    doubles as the stop-loss rule here.
 *  - Only one trade per stock at a time: while a trade is open, later
 *    signals on the same stock are ignored until it exits.
 *  - A trade still neither hit nor invalidated after MAX_HOLD_DAYS trading
 *    days, or still running when the data runs out, is marked "open" (not
 *    counted as a win or loss).
 */
export function backtestSymbol(symbol: string, candles: Candle[]): BacktestTrade[] {
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

      const shortCross = prevVal <= prevSt.value && cur > curSt.value;
      const targetStillBelowLine = targetValue < curSt.value;
      const longCross = prevVal >= prevSt.value && cur < curSt.value;
      const targetStillAboveLine = targetValue > curSt.value;

      let direction: "short" | "long" | null = null;
      if (shortCross && curSt.trend === "up" && haClose > curSt.value && targetStillBelowLine) {
        direction = "short";
      } else if (longCross && curSt.trend === "down" && haClose < curSt.value && targetStillAboveLine) {
        direction = "long";
      }
      if (!direction) continue;

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
        });
        break;
      }

      const entryPrice = candles[entryIndex].open;
      const entryDate = candles[entryIndex].date;

      let exitIndex: number | null = null;
      let exitReason: BacktestTrade["exitReason"] = "open";
      const maxJ = Math.min(candles.length - 1, entryIndex + MAX_HOLD_DAYS);

      for (let j = entryIndex; j <= maxJ; j++) {
        const targetNow = targetSeries[j];
        if (Number.isNaN(targetNow)) continue;

        const touchedTarget = direction === "short" ? candles[j].low <= targetNow : candles[j].high >= targetNow;
        if (touchedTarget) {
          exitIndex = j;
          exitReason = "target";
          break;
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
        exitPrice = exitReason === "target" ? targetSeries[exitIndex] : candles[exitIndex].close;
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
      });

      break; // one entry per signal day, even if multiple SMA rungs qualify
    }
  }

  return trades;
}
