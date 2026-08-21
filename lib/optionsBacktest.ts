import type { Candle } from "@/lib/kite";
import type { BacktestTrade } from "@/lib/backtest";
import { blackScholes, realizedVolatility, lastThursdayOfMonth } from "@/lib/optionsPricing";

const OTM_PERCENT = 3; // short leg: ~3% out of the money
const RISK_FREE_RATE = 0.065; // constant proxy, not fetched live
const DEFAULT_VOL_WINDOW_BARS = 20; // ~1 trading month of daily bars used as an IV proxy
const DEFAULT_PERIODS_PER_YEAR = 252; // daily bars

export type OptionTrade = {
  symbol: string;
  direction: "short" | "long";
  label: string;
  optionType: "PUT" | "CALL";
  isSpread: boolean;
  strike: number; // the sold (short) leg's strike
  longStrike: number | null; // the bought (protective) leg's strike, when isSpread
  expiryDate: string;
  signalDate: string;
  entryDate: string;
  underlyingEntryPrice: number;
  entryPremium: number; // net credit received: short leg premium, minus the long leg's cost if a spread
  exitDate: string | null;
  underlyingExitPrice: number | null;
  exitPremium: number | null; // net cost to close: short leg buy-back, minus the long leg's sale proceeds if a spread
  settledAtExpiry: boolean;
  underlyingExitReason: BacktestTrade["exitReason"];
  maxLossPerShare: number | null; // spread width minus the credit received; null (uncapped) when not a spread
  pnlPerShare: number | null;
  pnlPercent: number | null; // % of the credit collected, kept vs. paid back to close
  holdDays: number | null;
};

export type OptionsBacktestOptions = {
  // % further OTM (beyond the short leg's OTM_PERCENT) for a protective
  // long leg, turning the naked short into a credit spread — caps both the
  // max loss and the margin required. Omitted/0 = naked (uncapped downside,
  // the original single-leg behavior).
  spreadWidthPercent?: number;
  // How many bars of trailing realized volatility to use as the IV proxy,
  // and how many bars make up a year for annualizing it — both must match
  // what a single candle in `candles` actually represents. Defaults assume
  // daily bars (20-bar window, 252/year); pass scaled-up values for 4H/2H
  // candles (e.g. ~40 bars / ~504 per year for 4H) or premiums will be
  // priced off understated volatility.
  volWindowBars?: number;
  periodsPerYear?: number;
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
 * call, ~OTM_PERCENT% out of the money, expiring on the near-month NSE
 * monthly expiry. When spreadWidthPercent is given, a protective leg is
 * bought further OTM (short strike distance + spreadWidthPercent), turning
 * the naked short into a credit spread — the max loss becomes the strike
 * width minus the credit collected, instead of unbounded. Premiums are
 * MODELED with Black-Scholes off the underlying's own price and realized
 * volatility for both legs (same expiry, so same time-to-expiry) — not real
 * historical option-chain fills, since Kite doesn't reliably retain that
 * for expired contracts going back years. Treat results as estimates.
 *
 * The position is capped at expiry: if the underlying trade's own exit
 * (target/stop/Supertrend-flip) would land after that month's expiry, both
 * legs are instead settled at expiry using intrinsic value only (no time
 * value left), since the contracts wouldn't still exist by then.
 *
 * `candles` can be daily, 4H, or 2H bars — the expiry/settlement logic is
 * date-based and unaffected either way, but the volatility estimate isn't:
 * pass volWindowBars/periodsPerYear scaled to match, or premiums will be
 * priced off understated volatility (see OptionsBacktestOptions).
 */
export function toOptionTrade(
  trade: BacktestTrade,
  candles: Candle[],
  options: OptionsBacktestOptions = {}
): OptionTrade | null {
  const spreadWidthPercent =
    options.spreadWidthPercent && options.spreadWidthPercent > 0 ? options.spreadWidthPercent : null;
  const volWindowBars = options.volWindowBars && options.volWindowBars > 0 ? options.volWindowBars : DEFAULT_VOL_WINDOW_BARS;
  const periodsPerYear =
    options.periodsPerYear && options.periodsPerYear > 0 ? options.periodsPerYear : DEFAULT_PERIODS_PER_YEAR;

  const closes = candles.map((c) => c.close);
  const entryIdx = indexOnOrBefore(candles, toDateOnly(trade.entryDate));
  if (entryIdx === null) return null;

  const entryDateObj = utcFromDateOnly(toDateOnly(candles[entryIdx].date));
  const expiry = nearMonthExpiry(entryDateObj);
  const expiryDateOnly = toDateOnly(expiry.toISOString());

  const optionType: "PUT" | "CALL" = trade.direction === "long" ? "PUT" : "CALL";
  const shortStrike =
    optionType === "PUT" ? trade.entryPrice * (1 - OTM_PERCENT / 100) : trade.entryPrice * (1 + OTM_PERCENT / 100);
  const longStrike = spreadWidthPercent
    ? optionType === "PUT"
      ? trade.entryPrice * (1 - (OTM_PERCENT + spreadWidthPercent) / 100)
      : trade.entryPrice * (1 + (OTM_PERCENT + spreadWidthPercent) / 100)
    : null;

  const entryVol = realizedVolatility(closes, entryIdx, volWindowBars, periodsPerYear);
  const entryT = Math.max(0, (expiry.getTime() - entryDateObj.getTime()) / (365 * 24 * 60 * 60 * 1000));
  const shortEntryPremium = blackScholes(
    optionType === "PUT" ? "put" : "call",
    trade.entryPrice,
    shortStrike,
    entryT,
    RISK_FREE_RATE,
    entryVol
  );
  const longEntryPremium =
    longStrike !== null
      ? blackScholes(optionType === "PUT" ? "put" : "call", trade.entryPrice, longStrike, entryT, RISK_FREE_RATE, entryVol)
      : 0;
  const netEntryPremium = shortEntryPremium - longEntryPremium;

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
      isSpread: spreadWidthPercent !== null,
      strike: shortStrike,
      longStrike,
      expiryDate: expiryDateOnly,
      signalDate: trade.signalDate,
      entryDate: trade.entryDate,
      underlyingEntryPrice: trade.entryPrice,
      entryPremium: netEntryPremium,
      exitDate: null,
      underlyingExitPrice: null,
      exitPremium: null,
      settledAtExpiry: false,
      underlyingExitReason: trade.exitReason,
      maxLossPerShare: longStrike !== null ? Math.abs(longStrike - shortStrike) - netEntryPremium : null,
      pnlPerShare: null,
      pnlPercent: null,
      holdDays: null,
    };
  }

  const exitSpot = candles[exitIdx].close;
  let shortExitPremium: number;
  let longExitPremium: number;
  if (settledAtExpiry) {
    shortExitPremium = optionType === "PUT" ? Math.max(shortStrike - exitSpot, 0) : Math.max(exitSpot - shortStrike, 0);
    longExitPremium =
      longStrike !== null
        ? optionType === "PUT"
          ? Math.max(longStrike - exitSpot, 0)
          : Math.max(exitSpot - longStrike, 0)
        : 0;
  } else {
    const exitVol = realizedVolatility(closes, exitIdx, volWindowBars, periodsPerYear);
    const exitDateObj = utcFromDateOnly(toDateOnly(candles[exitIdx].date));
    const exitT = Math.max(0, (expiry.getTime() - exitDateObj.getTime()) / (365 * 24 * 60 * 60 * 1000));
    shortExitPremium = blackScholes(
      optionType === "PUT" ? "put" : "call",
      exitSpot,
      shortStrike,
      exitT,
      RISK_FREE_RATE,
      exitVol
    );
    longExitPremium =
      longStrike !== null
        ? blackScholes(optionType === "PUT" ? "put" : "call", exitSpot, longStrike, exitT, RISK_FREE_RATE, exitVol)
        : 0;
  }
  const netExitPremium = shortExitPremium - longExitPremium;

  const pnlPerShare = netEntryPremium - netExitPremium; // sold the spread, so profit = net credit kept
  const pnlPercent = netEntryPremium > 0.01 ? (pnlPerShare / netEntryPremium) * 100 : null;
  const maxLossPerShare = longStrike !== null ? Math.abs(longStrike - shortStrike) - netEntryPremium : null;

  return {
    symbol: trade.symbol,
    direction: trade.direction,
    label: trade.label,
    optionType,
    isSpread: spreadWidthPercent !== null,
    strike: shortStrike,
    longStrike,
    expiryDate: expiryDateOnly,
    signalDate: trade.signalDate,
    entryDate: trade.entryDate,
    underlyingEntryPrice: trade.entryPrice,
    entryPremium: netEntryPremium,
    exitDate: candles[exitIdx].date,
    underlyingExitPrice: exitSpot,
    exitPremium: netExitPremium,
    settledAtExpiry,
    underlyingExitReason: trade.exitReason,
    maxLossPerShare,
    pnlPerShare,
    pnlPercent,
    holdDays: exitIdx - entryIdx,
  };
}
