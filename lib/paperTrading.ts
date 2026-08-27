import { getOptionChain, spotQuoteKey, type ChainRow } from "@/lib/optionChain";
import { getOptionExpiries } from "@/lib/instruments";
import { getBasketMargin, quoteMidPrice, type Quote, type MarginOrder } from "@/lib/kite";
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
 * current month (see pickMonthlyExpiry), or manualStrikes.short if given.
 * This is deliberately the OPPOSITE mapping from "sell" mode, which is a
 * mean-reversion premium-collection bet (long signal sells a put betting
 * price won't fall through it, short sells a call betting it won't rise
 * through it — matching lib/optionsBacktest.ts's toOptionTrade), not a
 * directional one.
 *
 * "sell" builds a credit spread: the short leg ~1% OTM, a protective long
 * leg at least 4% OTM (naturally landing near 4-5% given typical NSE strike
 * spacing — see pickOtmAtLeast) — or, if manualStrikes is given (both
 * short and long), exactly the strikes the user chose instead of the
 * auto-picked ones.
 *
 * manualStrikes (either mode) lets the caller override the auto-picked
 * strike(s) with ones chosen off the live chain's bid/ask/mid (ChainLeg) —
 * a wide-spread or illiquid strike's last traded price can be badly stale,
 * which is exactly why picking strikes yourself is offered as an
 * alternative to the automatic picker.
 *
 * Premiums throughout use quoteMidPrice (bid/ask mid), not last_price —
 * the last trade on an illiquid or far-OTM strike can be hours old at a
 * very different underlying level, which is what produces "impossible"
 * readings like a further-OTM option pricing higher than a closer one.
 */
export async function buildTradePlan(
  symbol: string,
  direction: "short" | "long",
  mode: "buy" | "sell",
  manualStrikes?: { short: number; long?: number }
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
    const atmRow = manualStrikes
      ? chain.rows.find((r) => r.strike === manualStrikes.short) ?? null
      : pickClosestStrike(chain.rows, spot, side);
    const leg = atmRow ? legOf(atmRow, side) : null;
    if (!atmRow || !leg) {
      throw new Error(
        manualStrikes
          ? `Couldn't find strike ${manualStrikes.short} as a ${side} for ${symbol}.`
          : `No ${side} strikes found near the money for ${symbol}.`
      );
    }
    return {
      symbol,
      direction,
      mode,
      expiry: expiryChoice.expiry,
      tradingSessionsUntilExpiry: expiryChoice.tradingSessionsUntil,
      usedNextMonth: expiryChoice.usedNextMonth,
      underlyingPrice: spot,
      shortLeg: { tradingsymbol: leg.tradingsymbol, strike: atmRow.strike, optionType, premium: leg.mid, lotSize: leg.lotSize },
      longLeg: null,
      entryPremium: leg.mid,
    };
  }

  const optionType: "CE" | "PE" = direction === "long" ? "PE" : "CE";
  const side = optionType === "CE" ? "call" : "put";
  let shortRow: ChainRow | null;
  let longRow: ChainRow | null;
  if (manualStrikes && typeof manualStrikes.long === "number") {
    const long = manualStrikes.long;
    shortRow = chain.rows.find((r) => r.strike === manualStrikes.short) ?? null;
    longRow = chain.rows.find((r) => r.strike === long) ?? null;
  } else {
    const shortTarget = side === "call" ? spot * (1 + SHORT_LEG_OTM_PERCENT / 100) : spot * (1 - SHORT_LEG_OTM_PERCENT / 100);
    shortRow = pickClosestStrike(chain.rows, shortTarget, side);
    longRow = pickOtmAtLeast(chain.rows, spot, LONG_LEG_MIN_OTM_PERCENT, side);
  }
  const shortLegQuote = shortRow ? legOf(shortRow, side) : null;
  const longLegQuote = longRow ? legOf(longRow, side) : null;
  if (!shortRow || !longRow || !shortLegQuote || !longLegQuote) {
    throw new Error(
      manualStrikes
        ? `Couldn't find both chosen strikes (${manualStrikes.short}, ${manualStrikes.long}) as ${side}s for ${symbol}.`
        : `Couldn't find both spread legs for ${symbol} (short ~${SHORT_LEG_OTM_PERCENT}% OTM, long ≥${LONG_LEG_MIN_OTM_PERCENT}% OTM) — the option chain may not have enough strikes.`
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
      premium: shortLegQuote.mid,
      lotSize: shortLegQuote.lotSize,
    },
    longLeg: {
      tradingsymbol: longLegQuote.tradingsymbol,
      strike: longRow.strike,
      optionType,
      premium: longLegQuote.mid,
      lotSize: longLegQuote.lotSize,
    },
    entryPremium: shortLegQuote.mid - longLegQuote.mid,
  };
}

/**
 * The already-open position for a (symbol, mode), if any — so opening
 * "another" trade on the same signal instead adds to the existing one at
 * its own strike, rather than resolving a fresh (and possibly different,
 * since ATM/OTM strikes move with the underlying) strike each time.
 */
export function findOpenTrade(trades: PaperTrade[], symbol: string, mode: "buy" | "sell"): PaperTrade | undefined {
  return trades.find((t) => t.status === "open" && t.symbol === symbol && t.mode === mode);
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
): {
  premium: number;
  underlyingPrice: number;
  // The UNDERLYING stock/index's own move today — from its previous close
  // (Kite's ohlc.close, already on the same spot quote) to its current
  // price. Distinct from todayPnl below, which is the option position's
  // day P&L; this is just "how is the stock doing today," independent of
  // which way the trade is betting.
  underlyingChangeValue: number;
  underlyingChangePercent: number;
} | null {
  const shortQ = quotes[`NFO:${trade.shortLeg.tradingsymbol}`];
  const spotQ = quotes[spotQuoteKey(trade.symbol)];
  if (!shortQ || !spotQ) return null;

  let premium = quoteMidPrice(shortQ);
  if (trade.longLeg) {
    const longQ = quotes[`NFO:${trade.longLeg.tradingsymbol}`];
    if (!longQ) return null;
    premium = quoteMidPrice(shortQ) - quoteMidPrice(longQ);
  }

  const prevClose = spotQ.ohlc.close;
  const underlyingChangeValue = spotQ.last_price - prevClose;
  const underlyingChangePercent = prevClose !== 0 ? (underlyingChangeValue / prevClose) * 100 : 0;

  return { premium, underlyingPrice: spotQ.last_price, underlyingChangeValue, underlyingChangePercent };
}

/**
 * Today's ₹ P&L for one open trade — the day's move, not the position's
 * whole-life P&L (which is entryPremium vs. current, already shown
 * separately). If the position was opened today, that IS its whole current
 * unrealized P&L — there's no "yesterday" to measure from. Otherwise it's
 * measured from each leg's previous close (Kite's own ohlc.close on every
 * quote — no extra API call) to its current mid, the standard "day change"
 * definition a broker shows. A position topped up today after being opened
 * on an earlier day is measured uniformly from the earlier reference point
 * across its whole (weighted-average) size — a documented approximation,
 * since per-lot entry dates aren't tracked separately from the single
 * weighted-average entryPremium (see weightedAveragePremium).
 */
export function computeTodayPnl(
  trade: Pick<PaperTrade, "mode" | "shortLeg" | "longLeg" | "entryAt" | "entryPremium" | "lots" | "lotSize">,
  quotes: Record<string, Quote>,
  today: Date
): number | null {
  const shortQ = quotes[`NFO:${trade.shortLeg.tradingsymbol}`];
  if (!shortQ) return null;
  const longQ = trade.longLeg ? quotes[`NFO:${trade.longLeg.tradingsymbol}`] : null;
  if (trade.longLeg && !longQ) return null;

  const currentPremium = longQ ? quoteMidPrice(shortQ) - quoteMidPrice(longQ) : quoteMidPrice(shortQ);
  const openedToday = trade.entryAt.slice(0, 10) === today.toISOString().slice(0, 10);
  const referencePremium = openedToday
    ? trade.entryPremium
    : longQ
      ? shortQ.ohlc.close - longQ.ohlc.close
      : shortQ.ohlc.close;

  return computePnlPerShare(trade.mode, referencePremium, currentPremium) * trade.lots * trade.lotSize;
}

function spreadMarginOrders(shortTradingsymbol: string, longTradingsymbol: string, quantity: number): MarginOrder[] {
  return [
    {
      exchange: "NFO",
      tradingsymbol: shortTradingsymbol,
      transaction_type: "SELL",
      variety: "regular",
      product: "NRML",
      order_type: "MARKET",
      quantity,
    },
    {
      exchange: "NFO",
      tradingsymbol: longTradingsymbol,
      transaction_type: "BUY",
      variety: "regular",
      product: "NRML",
      order_type: "MARKET",
      quantity,
    },
  ];
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
  const orders = spreadMarginOrders(plan.shortLeg.tradingsymbol, plan.longLeg.tradingsymbol, lots * plan.shortLeg.lotSize);
  return getBasketMargin(orders, accessToken);
}

/**
 * Fills in capitalRequired for a trade that doesn't have one yet — either
 * it predates the field being tracked at all, or the margin lookup failed
 * when it was opened. Computed from the trade's own already-stored data
 * (no fresh option-chain fetch needed), so it's cheap to try on every Live
 * refresh. A no-op (returns the existing value unchanged) once it's known.
 */
export async function backfillCapitalRequired(trade: PaperTrade, accessToken: string): Promise<number | null> {
  if (typeof trade.capitalRequired === "number") return trade.capitalRequired;
  return computeMarginForQuantity(trade, trade.lots, accessToken);
}

/** Same margin computation as computeCapitalRequired/backfillCapitalRequired, but for an arbitrary quantity (in lots) rather than always the trade's own current lots — used when the lot count is about to change (adding to or trimming a position) and the capital figure needs to reflect the NEW size, not the old one. */
export async function computeMarginForQuantity(
  trade: Pick<PaperTrade, "mode" | "entryPremium" | "lotSize" | "shortLeg" | "longLeg">,
  lots: number,
  accessToken: string
): Promise<number | null> {
  if (trade.mode === "buy") {
    return trade.entryPremium * lots * trade.lotSize;
  }
  if (!trade.longLeg) return null;
  const orders = spreadMarginOrders(trade.shortLeg.tradingsymbol, trade.longLeg.tradingsymbol, lots * trade.lotSize);
  return getBasketMargin(orders, accessToken);
}

/** Lots-weighted average premium after adding `addLots` at `addPremium` to an existing `oldLots` at `oldPremium` — standard averaging-in, same as a real broker would blend a top-up into an existing position's average price. */
export function weightedAveragePremium(oldPremium: number, oldLots: number, addPremium: number, addLots: number): number {
  return (oldPremium * oldLots + addPremium * addLots) / (oldLots + addLots);
}

export type PartialCloseResult = {
  closedLots: number;
  remainingLots: number;
  pnl: number; // realized ₹ for just the closed portion
  capitalReleased: number | null; // this closed portion's share of the pre-close capitalRequired, scaled by lots
  remainingCapitalRequired: number | null; // what's left open's share of the pre-close capitalRequired, scaled by lots — null once remainingLots is 0
};

/**
 * Splits off `lotsToClose` (clamped to however many are actually open) at
 * `exitPremium`, realizing P&L on just that portion. Capital is allocated
 * between the closed and still-open portions by simple proportional
 * scaling of the pre-close capitalRequired (capital is roughly linear per
 * lot for the same contract, unlike comparing genuinely different
 * contracts) — cheaper than a fresh margin call on every partial close, and
 * accurate enough for the same strikes at a different quantity.
 */
export function computePartialClose(
  trade: Pick<PaperTrade, "mode" | "entryPremium" | "lots" | "lotSize" | "capitalRequired">,
  lotsToClose: number,
  exitPremium: number
): PartialCloseResult {
  const closedLots = Math.min(Math.max(lotsToClose, 0), trade.lots);
  const remainingLots = trade.lots - closedLots;
  const pnl = computePnlPerShare(trade.mode, trade.entryPremium, exitPremium) * closedLots * trade.lotSize;
  const capitalPerLot =
    typeof trade.capitalRequired === "number" && trade.lots > 0 ? trade.capitalRequired / trade.lots : null;
  return {
    closedLots,
    remainingLots,
    pnl,
    capitalReleased: capitalPerLot !== null ? capitalPerLot * closedLots : null,
    remainingCapitalRequired: remainingLots > 0 && capitalPerLot !== null ? capitalPerLot * remainingLots : null,
  };
}

/** Identifies the exact contract a trade holds — same underlying, mode, and leg(s) — so two records can be recognized as genuinely the same position rather than merely the same symbol at a different strike or mode. */
function duplicateGroupKey(trade: Pick<PaperTrade, "symbol" | "mode" | "shortLeg" | "longLeg">): string {
  return [trade.symbol, trade.mode, trade.shortLeg.tradingsymbol, trade.longLeg?.tradingsymbol ?? ""].join("|");
}

/**
 * Finds sets of 2+ open trades that are the exact same contract — true
 * duplicates (e.g. from opening a position twice before the same-strike
 * reuse guard existed, or a submit race), not just the same underlying at a
 * different strike or in a different mode, which are legitimately separate
 * positions.
 */
export function findDuplicateOpenGroups(trades: PaperTrade[]): PaperTrade[][] {
  const byKey = new Map<string, PaperTrade[]>();
  for (const t of trades) {
    if (t.status !== "open" || t.lots <= 0) continue;
    const key = duplicateGroupKey(t);
    const arr = byKey.get(key) ?? [];
    arr.push(t);
    byKey.set(key, arr);
  }
  return Array.from(byKey.values()).filter((g) => g.length > 1);
}

/**
 * Combines a group of duplicate open trades (same symbol/mode/legs) into a
 * single PaperTrade: lots sum, entryPremium becomes the lots-weighted
 * average across the group (same averaging-in logic as a top-up), and
 * closedLots histories are concatenated so no realized P&L from either
 * record is lost. The earliest trade's id/entryAt/entryUnderlyingPrice/
 * expiry become the merged trade's identity. capitalRequired is left null
 * here — two duplicates opened days apart may have priced margin
 * differently, so the caller re-prices it fresh for the combined lot count
 * rather than summing two possibly-stale figures.
 */
export function mergeOpenTradeGroup(group: PaperTrade[]): PaperTrade {
  const sorted = [...group].sort((a, b) => a.entryAt.localeCompare(b.entryAt));
  const earliest = sorted[0];
  const totalLots = sorted.reduce((sum, t) => sum + t.lots, 0);
  const entryPremium = sorted.reduce((sum, t) => sum + t.entryPremium * t.lots, 0) / totalLots;
  const closedLots = sorted.flatMap((t) => t.closedLots).sort((a, b) => a.closedAt.localeCompare(b.closedAt));
  const latestMarked = sorted
    .filter((t) => typeof t.lastMarkAt === "string")
    .sort((a, b) => (b.lastMarkAt as string).localeCompare(a.lastMarkAt as string))[0];

  return {
    ...earliest,
    lots: totalLots,
    entryPremium,
    closedLots,
    lastMarkPremium: latestMarked?.lastMarkPremium ?? null,
    lastMarkAt: latestMarked?.lastMarkAt ?? null,
    capitalRequired: null,
    // Each duplicate's todayPnl was sized for its OWN lots, not the merged
    // total — carrying one over would misstate it. Corrected on the next
    // Live press, same as capitalRequired above.
    todayPnl: null,
  };
}
