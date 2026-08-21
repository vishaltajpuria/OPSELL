import type { Candle } from "@/lib/kite";
import type { BacktestTrade } from "@/lib/backtest";
import { blackScholes, realizedVolatility, lastThursdayOfMonth } from "@/lib/optionsPricing";

const OTM_PERCENT = 3; // ~3% out of the money
const RISK_FREE_RATE = 0.065; // constant proxy, not fetched live
const VOL_WINDOW = 20; // trading days of realized vol used as an IV proxy

export type OptionTrade = {
  symbol: string;
  direction: "short" | "long";
  label: string;
  optionType: "PUT" | "CALL";
  strike: number;
  expiryDate: string;
  signalDate: string;
  entryDate: string;
  underlyingEntryPrice: number;
  entryPremium: number;
  exitDate: string | null;
  underlyingExitPrice: number | null;
  exitPremium: number | null;
  settledAtExpiry: boolean;
  underlyingExitReason: BacktestTrade["exitReason"];
  pnlPerShare: number | null;
  pnlPercent: number | null; // % of the premium collected, kept vs. paid back to close
  holdDays: number | null;
};

function toDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function utcFromDateOnly(dateOnly: string): Date {
  const [y, m, d] = dateOnly.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

// The near-month NSE monthly expiry relative to a signal date: normally
// that calendar month's last Thursday, but rolled to next month if the
// signal fires after that Thursday's already passed (there's no "same
// month" contract left to sell by then).
function nearMonthExpiry(entryDate: Date): Date {
  let expiry = lastThursdayOfMonth(entryDate.getUTCFullYear(), entryDate.getUTCMonth());
  if (entryDate.getTime() >= expiry.getTime()) {
    expiry = lastThursdayOfMonth(entryDate.getUTCFullYear(), entryDate.getUTCMonth() + 1);
  }
  return expiry;
}

// Candle index for a date, or the closest available trading day on/before
// it (candles are chronologically sorted ascending).
function indexOnOrBefore(candles: Candle[], dateOnly: string): number | null {
  let best = -1;
  for (let i = 0; i < candles.length; i++) {
    if (toDateOnly(candles[i].date) <= dateOnly) best = i;
    else break;
  }
  return best >= 0 ? best : null;
}

/**
 * Converts one underlying stock trade (from backtestSymbol) into a modeled
 * option-selling trade: a long signal sells a put, a short signal sells a
 * call, both ~OTM_PERCENT% out of the money, expiring on the near-month NSE
 * monthly expiry. Premiums are MODELED with Black-Scholes off the
 * underlying's own price and realized volatility — not real historical
 * option-chain fills, since Kite doesn't reliably retain that for expired
 * contracts going back years. Treat results as estimates.
 *
 * The position is capped at expiry: if the underlying trade's own exit
 * (target/stop/Supertrend-flip) would land after that month's expiry, the
 * option is instead settled at expiry using intrinsic value only (no time
 * value left), since the contract wouldn't still exist by then.
 */
export function toOptionTrade(trade: BacktestTrade, candles: Candle[]): OptionTrade | null {
  const closes = candles.map((c) => c.close);
  const entryIdx = indexOnOrBefore(candles, toDateOnly(trade.entryDate));
  if (entryIdx === null) return null;

  const entryDateObj = utcFromDateOnly(toDateOnly(candles[entryIdx].date));
  const expiry = nearMonthExpiry(entryDateObj);
  const expiryDateOnly = toDateOnly(expiry.toISOString());

  const optionType: "PUT" | "CALL" = trade.direction === "long" ? "PUT" : "CALL";
  const strike =
    optionType === "PUT" ? trade.entryPrice * (1 - OTM_PERCENT / 100) : trade.entryPrice * (1 + OTM_PERCENT / 100);

  const entryVol = realizedVolatility(closes, entryIdx, VOL_WINDOW);
  const entryT = Math.max(0, (expiry.getTime() - entryDateObj.getTime()) / (365 * 24 * 60 * 60 * 1000));
  const entryPremium = blackScholes(
    optionType === "PUT" ? "put" : "call",
    trade.entryPrice,
    strike,
    entryT,
    RISK_FREE_RATE,
    entryVol
  );

  let optionExitDateOnly: string;
  let settledAtExpiry = false;
  if (trade.exitDate === null || utcFromDateOnly(toDateOnly(trade.exitDate)).getTime() >= expiry.getTime()) {
    optionExitDateOnly = expiryDateOnly;
    settledAtExpiry = true;
  } else {
    optionExitDateOnly = toDateOnly(trade.exitDate);
  }

  const exitIdx = indexOnOrBefore(candles, optionExitDateOnly);
  if (exitIdx === null || exitIdx < entryIdx) {
    return {
      symbol: trade.symbol,
      direction: trade.direction,
      label: trade.label,
      optionType,
      strike,
      expiryDate: expiryDateOnly,
      signalDate: trade.signalDate,
      entryDate: trade.entryDate,
      underlyingEntryPrice: trade.entryPrice,
      entryPremium,
      exitDate: null,
      underlyingExitPrice: null,
      exitPremium: null,
      settledAtExpiry: false,
      underlyingExitReason: trade.exitReason,
      pnlPerShare: null,
      pnlPercent: null,
      holdDays: null,
    };
  }

  const exitSpot = candles[exitIdx].close;
  let exitPremium: number;
  if (settledAtExpiry) {
    exitPremium = optionType === "PUT" ? Math.max(strike - exitSpot, 0) : Math.max(exitSpot - strike, 0);
  } else {
    const exitVol = realizedVolatility(closes, exitIdx, VOL_WINDOW);
    const exitDateObj = utcFromDateOnly(toDateOnly(candles[exitIdx].date));
    const exitT = Math.max(0, (expiry.getTime() - exitDateObj.getTime()) / (365 * 24 * 60 * 60 * 1000));
    exitPremium = blackScholes(optionType === "PUT" ? "put" : "call", exitSpot, strike, exitT, RISK_FREE_RATE, exitVol);
  }

  const pnlPerShare = entryPremium - exitPremium; // sold it, so profit = premium kept
  const pnlPercent = entryPremium > 0.01 ? (pnlPerShare / entryPremium) * 100 : null;

  return {
    symbol: trade.symbol,
    direction: trade.direction,
    label: trade.label,
    optionType,
    strike,
    expiryDate: expiryDateOnly,
    signalDate: trade.signalDate,
    entryDate: trade.entryDate,
    underlyingEntryPrice: trade.entryPrice,
    entryPremium,
    exitDate: candles[exitIdx].date,
    underlyingExitPrice: exitSpot,
    exitPremium,
    settledAtExpiry,
    underlyingExitReason: trade.exitReason,
    pnlPerShare,
    pnlPercent,
    holdDays: exitIdx - entryIdx,
  };
}
