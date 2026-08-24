import { getOptionChain, spotQuoteKey, type ChainRow } from "@/lib/optionChain";
import { getOptionExpiries } from "@/lib/instruments";
import { getBasketMargin, type Quote, type MarginOrder } from "@/lib/kite";
import type { PaperTrade } from "@/lib/kv";

// "Buy ATM option of current month expiry (if more than 12 trading sessions
// are left, otherwise buy next month expiry option)" — the threshold as
// specified by the user.
const MIN_TRADING_SESSIONS = 12;

// Trading-session count is a weekday-only approximation (Mon-Fri, no NSE
// holiday calendar) — occasionally off by one or two sessions around a
// market holiday, but not enough to change which expiry gets picked except
// right at the 12-session boundary.
export function countTradingSessionsUntil(today: Date, expiry: Date): number {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const end = new Date(Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth(), expiry.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 1); // count sessions AFTER today, not including today itself
  let count = 0;
  while (d.getTime() <= end.getTime()) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) count++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

export type MonthlyExpiryChoice = {
  expiry: string;
  tradingSessionsUntil: number;
  usedNextMonth: boolean;
};

/**
 * Picks the near-month or next-month MONTHLY expiry from a list of every
 * available expiry for a symbol (which may include weekly expiries, for
 * indices). "Monthly" is derived from real instrument data — the latest
 * expiry occurring within each calendar month — rather than a naive
 * last-Thursday-of-month calendar formula, since NSE shifts an expiry
 * landing on a holiday to the previous trading day.
 *
 * Picks the nearest upcoming monthly expiry; if fewer than
 * MIN_TRADING_SESSIONS (12) trading sessions remain until it, rolls to the
 * next month's monthly expiry instead — there usually isn't enough runway
 * left in a contract that close to expiry for a directional option-buying
 * setup to play out.
 */
export function pickMonthlyExpiry(allExpiries: string[], today: Date): MonthlyExpiryChoice | null {
  const todayIso = today.toISOString().slice(0, 10);
  const upcoming = allExpiries.filter((e) => e >= todayIso).sort();
  if (upcoming.length === 0) return null;

  const latestPerMonth = new Map<string, string>();
  for (const e of upcoming) {
    const monthKey = e.slice(0, 7);
    const existing = latestPerMonth.get(monthKey);
    if (!existing || e > existing) latestPerMonth.set(monthKey, e);
  }
  const monthlyExpiries = Array.from(latestPerMonth.values()).sort();
  if (monthlyExpiries.length === 0) return null;

  const nearExpiry = monthlyExpiries[0];
  const nearSessions = countTradingSessionsUntil(today, new Date(nearExpiry + "T00:00:00Z"));
  if (nearSessions > MIN_TRADING_SESSIONS || monthlyExpiries.length < 2) {
    return { expiry: nearExpiry, tradingSessionsUntil: nearSessions, usedNextMonth: false };
  }

  const nextExpiry = monthlyExpiries[1];
  return {
    expiry: nextExpiry,
    tradingSessionsUntil: countTradingSessionsUntil(today, new Date(nextExpiry + "T00:00:00Z")),
    usedNextMonth: true,
  };
}

function legOf(row: ChainRow, side: "call" | "put") {
  return side === "call" ? row.call : row.put;
}

/** The strike whose premium-quoted leg is closest to targetPrice. */
export function pickClosestStrike(rows: ChainRow[], targetPrice: number, side: "call" | "put"): ChainRow | null {
  const candidates = rows.filter((r) => legOf(r, side) !== null);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, r) => (Math.abs(r.strike - targetPrice) < Math.abs(best.strike - targetPrice) ? r : best));
}

/**
 * The strike at least minPercent away from spot (OTM in the direction
 * implied by `side` — a call's OTM direction is above spot, a put's is
 * below), preferring the SMALLEST distance that still clears the floor —
 * i.e. picks the strike right at or just past minPercent, not the most
 * extreme one available. Used for the protective spread leg ("at least
 * 4-5% away"): this naturally lands in that band on typical NSE strike
 * spacing rather than jumping to some much-further strike.
 */
export function pickOtmAtLeast(rows: ChainRow[], spot: number, minPercent: number, side: "call" | "put"): ChainRow | null {
  const minDistance = spot * (minPercent / 100);
  const candidates = rows
    .filter((r) => legOf(r, side) !== null)
    .map((r) => ({ row: r, distance: side === "call" ? r.strike - spot : spot - r.strike }))
    .filter((c) => c.distance >= minDistance - 1e-6);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => (c.distance < best.distance ? c : best)).row;
}

/**
 * P&L per share/unit (before lots * lotSize scaling): "buy" mode profits
 * when the premium rises (we paid entryPremium, current value is
 * currentPremium); "sell" mode profits when it falls (we collected
 * entryPremium as a net credit, currentPremium is the net cost to close) —
 * same sign convention as toOptionTrade in lib/optionsBacktest.ts.
 */
export function computePnlPerShare(mode: "buy" | "sell", entryPremium: number, currentPremium: number): number {
  return mode === "buy" ? currentPremium - entryPremium : entryPremium - currentPremium;
}

const SHORT_LEG_OTM_PERCENT = 1; // "sell the OTM option 1% away from LTP"
const LONG_LEG_MIN_OTM_PERCENT = 4; // "buy the option at least 4-5% away from LTP"

export type TradePlanLeg = {
  tradingsymbol: string;
  strike: number;
  optionType: "CE" | "PE";
  premium: number;
  lotSize: number;
};

export type TradePlan = {
  symbol: string;
  direction: "short" | "long";
  mode: "buy" | "sell";
  expiry: string;
  tradingSessionsUntilExpiry: number;
  usedNextMonth: boolean;
  underlyingPrice: number;
  shortLeg: TradePlanLeg; // the only leg in "buy" mode; the sold leg in "sell" mode
  longLeg: TradePlanLeg | null; // protective leg, "sell" mode only
  entryPremium: number; // net of both legs if a spread
};

/**
 * Resolves a signal (symbol + direction) into a concrete option trade plan,
 * fetching a live option chain to do it — real strikes and real current
 * premiums, not modeled/estimated ones (unlike the backtest tool's
 * Black-Scholes approach, since this is meant to validate against actual
 * tradable prices).
 *
 * "buy" is a naked, purely DIRECTIONAL bet aligned with the signal's
 * expected move — long (expecting a reversal UP) buys a call, short
 * (expecting a reversal DOWN) buys a put — at the current month's ATM
 * strike, or next month's if fewer than 12 trading sessions remain in the
 * current month (see pickMonthlyExpiry). This is deliberately the OPPOSITE
 * mapping from "sell" mode, which is a mean-reversion premium-collection
 * bet (long signal sells a put betting price won't fall through it, short
 * sells a call betting it won't rise through it — matching
 * lib/optionsBacktest.ts's toOptionTrade), not a directional one.
 *
 * "sell" builds a credit spread: the short leg ~1% OTM, a protective long
 * leg at least 4% OTM (naturally landing near 4-5% given typical NSE strike
 * spacing — see pickOtmAtLeast).
 */
export async function buildTradePlan(
  symbol: string,
  direction: "short" | "long",
  mode: "buy" | "sell"
): Promise<TradePlan> {
  const expiries = await getOptionExpiries(symbol);
  const expiryChoice = pickMonthlyExpiry(expiries, new Date());
  if (!expiryChoice) {
    throw new Error(
      `No option expiries found for ${symbol} — it may not have listed options here (e.g. SENSEX options trade on BSE, which this app doesn't fetch instrument data for).`
    );
  }

  const chain = await getOptionChain(symbol, expiryChoice.expiry);
  if (chain.rows.length === 0 || chain.spotPrice === null) {
    throw new Error(`No option chain data available for ${symbol} ${expiryChoice.expiry}.`);
  }
  const spot = chain.spotPrice;

  if (mode === "buy") {
    const optionType: "CE" | "PE" = direction === "long" ? "CE" : "PE";
    const side = optionType === "CE" ? "call" : "put";
    const atmRow = pickClosestStrike(chain.rows, spot, side);
    const leg = atmRow ? legOf(atmRow, side) : null;
    if (!atmRow || !leg) throw new Error(`No ${side} strikes found near the money for ${symbol}.`);
    return {
      symbol,
      direction,
      mode,
      expiry: expiryChoice.expiry,
      tradingSessionsUntilExpiry: expiryChoice.tradingSessionsUntil,
      usedNextMonth: expiryChoice.usedNextMonth,
      underlyingPrice: spot,
      shortLeg: { tradingsymbol: leg.tradingsymbol, strike: atmRow.strike, optionType, premium: leg.ltp, lotSize: leg.lotSize },
      longLeg: null,
      entryPremium: leg.ltp,
    };
  }

  const optionType: "CE" | "PE" = direction === "long" ? "PE" : "CE";
  const side = optionType === "CE" ? "call" : "put";
  const shortTarget = side === "call" ? spot * (1 + SHORT_LEG_OTM_PERCENT / 100) : spot * (1 - SHORT_LEG_OTM_PERCENT / 100);
  const shortRow = pickClosestStrike(chain.rows, shortTarget, side);
  const longRow = pickOtmAtLeast(chain.rows, spot, LONG_LEG_MIN_OTM_PERCENT, side);
  const shortLegQuote = shortRow ? legOf(shortRow, side) : null;
  const longLegQuote = longRow ? legOf(longRow, side) : null;
  if (!shortRow || !longRow || !shortLegQuote || !longLegQuote) {
    throw new Error(
      `Couldn't find both spread legs for ${symbol} (short ~${SHORT_LEG_OTM_PERCENT}% OTM, long ≥${LONG_LEG_MIN_OTM_PERCENT}% OTM) — the option chain may not have enough strikes.`
    );
  }
  if (longRow.strike === shortRow.strike) {
    throw new Error(`Short and protective legs resolved to the same strike for ${symbol} — not enough distinct strikes for a spread.`);
  }

  return {
    symbol,
    direction,
    mode,
    expiry: expiryChoice.expiry,
    tradingSessionsUntilExpiry: expiryChoice.tradingSessionsUntil,
    usedNextMonth: expiryChoice.usedNextMonth,
    underlyingPrice: spot,
    shortLeg: {
      tradingsymbol: shortLegQuote.tradingsymbol,
      strike: shortRow.strike,
      optionType,
      premium: shortLegQuote.ltp,
      lotSize: shortLegQuote.lotSize,
    },
    longLeg: {
      tradingsymbol: longLegQuote.tradingsymbol,
      strike: longRow.strike,
      optionType,
      premium: longLegQuote.ltp,
      lotSize: longLegQuote.lotSize,
    },
    entryPremium: shortLegQuote.ltp - longLegQuote.ltp,
  };
}

/** Every Kite quote key needed to mark one open trade to market. */
export function tradeQuoteKeys(trade: Pick<PaperTrade, "symbol" | "shortLeg" | "longLeg">): string[] {
  const keys = [`NFO:${trade.shortLeg.tradingsymbol}`, spotQuoteKey(trade.symbol)];
  if (trade.longLeg) keys.push(`NFO:${trade.longLeg.tradingsymbol}`);
  return keys;
}

/**
 * Current net premium and underlying price for one trade, from a batch of
 * already-fetched quotes (see tradeQuoteKeys) — pulled out as its own
 * function so /refresh can batch every open trade's quotes into one Kite
 * call and then mark each trade individually from the shared result.
 */
export function markToMarket(
  trade: Pick<PaperTrade, "symbol" | "shortLeg" | "longLeg">,
  quotes: Record<string, Quote>
): { premium: number; underlyingPrice: number } | null {
  const shortQ = quotes[`NFO:${trade.shortLeg.tradingsymbol}`];
  const spotQ = quotes[spotQuoteKey(trade.symbol)];
  if (!shortQ || !spotQ) return null;

  let premium = shortQ.last_price;
  if (trade.longLeg) {
    const longQ = quotes[`NFO:${trade.longLeg.tradingsymbol}`];
    if (!longQ) return null;
    premium = shortQ.last_price - longQ.last_price;
  }
  return { premium, underlyingPrice: spotQ.last_price };
}

/**
 * Capital tied up by opening this plan, total ₹ (lots already applied):
 * "buy" is just the premium paid — no API call needed, always known.
 * "sell" is the real hedge-aware margin Kite's basket-margin endpoint would
 * require for holding both legs together (the long leg reduces margin vs. a
 * naked short) — held as NRML since a paper position isn't auto-squared off
 * intraday. Returns null only if that margin lookup fails; the caller still
 * opens the trade, just without a capital figure for it yet.
 */
export async function computeCapitalRequired(plan: TradePlan, lots: number, accessToken: string): Promise<number | null> {
  if (plan.mode === "buy") {
    return plan.entryPremium * lots * plan.shortLeg.lotSize;
  }
  if (!plan.longLeg) return null;
  const quantity = lots * plan.shortLeg.lotSize;
  const orders: MarginOrder[] = [
    {
      exchange: "NFO",
      tradingsymbol: plan.shortLeg.tradingsymbol,
      transaction_type: "SELL",
      variety: "regular",
      product: "NRML",
      order_type: "MARKET",
      quantity,
    },
    {
      exchange: "NFO",
      tradingsymbol: plan.longLeg.tradingsymbol,
      transaction_type: "BUY",
      variety: "regular",
      product: "NRML",
      order_type: "MARKET",
      quantity,
    },
  ];
  return getBasketMargin(orders, accessToken);
}
