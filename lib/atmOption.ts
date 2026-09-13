import { getOptionExpiries, getOptionChainInstruments } from "@/lib/instruments";
import { getQuote, quoteBidAsk, quoteMidPrice } from "@/lib/kite";
import { pickMonthlyExpiry } from "@/lib/paperTrading";

// "Use current month expiry unless 6 trading sessions are left, after that
// move to next month" — Strategy Tab 2's own rollover point for this
// display-only ATM/ITM option, distinct from paper trading's 12-session
// threshold (lib/paperTrading.ts's MIN_TRADING_SESSIONS): there's no real
// position here to worry about running out of runway on, just a
// representative contract to price.
const DISPLAY_MIN_TRADING_SESSIONS = 6;

export type AtmOptionInfo = {
  expiry: string;
  tradingSessionsUntilExpiry: number;
  usedNextMonth: boolean;
  strike: number;
  optionType: "CE" | "PE";
  tradingsymbol: string;
  premium: number; // mid of bid/ask, falling back to last_price — see quoteMidPrice
  premiumPercentOfStrike: number; // premium / strike * 100 — e.g. a 124 premium on a 12400 strike is 1%
  bid: number | null;
  ask: number | null;
  bidAskSpreadPercent: number | null; // (ask-bid)/premium*100 — null if either side of the book is empty
};

/**
 * The strike closest to spot on the ITM side — not simply the nearest
 * strike overall, which could land either side. A call's ITM side is at or
 * below spot, so round DOWN to the largest available strike <= spot; a
 * put's ITM side is at or above spot, so round UP to the smallest strike >=
 * spot. Falls back to the nearest available strike on the wrong side only
 * when the chain doesn't extend far enough to have any strike on the ITM
 * side at all (spot sitting beyond every listed strike).
 */
export function pickItmStrike(strikes: number[], spot: number, optionType: "CE" | "PE"): number | null {
  const sorted = Array.from(new Set(strikes)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (optionType === "CE") {
    const itmOrAtm = sorted.filter((s) => s <= spot);
    return itmOrAtm.length > 0 ? itmOrAtm[itmOrAtm.length - 1] : sorted[0];
  }
  const itmOrAtm = sorted.filter((s) => s >= spot);
  return itmOrAtm.length > 0 ? itmOrAtm[0] : sorted[sorted.length - 1];
}

/**
 * Resolves a representative ATM/ITM option contract for a signal — the
 * expiry, strike, live premium, and bid/ask spread — used for Strategy Tab
 * 2's display and ranking (see rankSignals in app/strategy2/page.tsx), not
 * for placing any actual trade (lib/paperTrading.ts's buildTradePlan is the
 * real trade-planning path, with its own expiry/strike rules).
 *
 * direction "long" -> call (CE), "short" -> put (PE), same mapping as
 * buildTradePlan's "buy" mode. Returns null (never throws) on any failure —
 * no expiry, no strikes on that side, or the quote itself missing — since a
 * stock's WT signal is still valid without a priced option to show
 * alongside it; the caller treats a null return as "no option data
 * available" rather than failing the whole signal.
 */
export async function resolveAtmOption(
  symbol: string,
  spot: number,
  direction: "long" | "short",
  accessToken: string
): Promise<AtmOptionInfo | null> {
  const optionType: "CE" | "PE" = direction === "long" ? "CE" : "PE";

  const expiries = await getOptionExpiries(symbol, accessToken);
  const expiryChoice = pickMonthlyExpiry(expiries, new Date(), DISPLAY_MIN_TRADING_SESSIONS);
  if (!expiryChoice) return null;

  const instruments = await getOptionChainInstruments(symbol, expiryChoice.expiry, accessToken);
  const sideInstruments = instruments.filter((i) => i.optionType === optionType);
  if (sideInstruments.length === 0) return null;

  const strike = pickItmStrike(sideInstruments.map((i) => i.strike), spot, optionType);
  const inst = strike !== null ? sideInstruments.find((i) => i.strike === strike) : undefined;
  if (strike === null || !inst) return null;

  const key = `NFO:${inst.tradingsymbol}`;
  const quotes = await getQuote([key], accessToken);
  const q = quotes[key];
  if (!q) return null;

  const { bid, ask } = quoteBidAsk(q);
  const premium = quoteMidPrice(q);
  const premiumPercentOfStrike = strike !== 0 ? (premium / strike) * 100 : 0;
  const bidAskSpreadPercent = bid !== null && ask !== null && premium !== 0 ? ((ask - bid) / premium) * 100 : null;

  return {
    expiry: expiryChoice.expiry,
    tradingSessionsUntilExpiry: expiryChoice.tradingSessionsUntil,
    usedNextMonth: expiryChoice.usedNextMonth,
    strike,
    optionType,
    tradingsymbol: inst.tradingsymbol,
    premium,
    premiumPercentOfStrike,
    bid,
    ask,
    bidAskSpreadPercent,
  };
}
