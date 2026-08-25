import { NextRequest, NextResponse } from "next/server";
import { isConnected } from "@/lib/session";
import { requireAccessToken, KiteAuthError } from "@/lib/kite";
import { batchQuote } from "@/lib/quoteBatch";
import { buildTradePlan, findOpenTrade, tradeQuoteKeys, markToMarket } from "@/lib/paperTrading";
import { getPaperTrades } from "@/lib/kv";

// Resolves a candidate signal into a concrete, priced trade plan for the
// user to review before confirming — nothing is persisted here.
//
// If a position on this (symbol, mode) is already open, this returns an
// "increase" preview instead of a fresh plan: the EXISTING strike(s), just
// a freshly-fetched current premium for them — never a newly-resolved
// ATM/OTM strike, since today's could differ from the one already held.
// /start re-resolves a fresh plan at confirm time for a brand-new position;
// /increase re-fetches the existing position's live quote at confirm time —
// either way nothing here is trusted as final, this is preview-only.
export async function POST(request: NextRequest) {
  if (!isConnected()) {
    return NextResponse.json({ error: "Not connected to Zerodha." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const symbol = typeof body?.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const direction = body?.direction === "short" || body?.direction === "long" ? body.direction : null;
  const mode = body?.mode === "buy" || body?.mode === "sell" ? body.mode : null;
  if (!symbol || !direction || !mode) {
    return NextResponse.json({ error: "symbol, direction ('short'|'long'), and mode ('buy'|'sell') are required." }, { status: 400 });
  }
  // Optional: price a specific strike (buy mode) or pair of strikes (sell
  // mode) instead of the auto-picked one(s) — the "choose my strikes" flow.
  // Ignored for an existing position (isIncrease branch below always
  // reuses whatever strike(s) it already holds).
  const manualStrikes =
    typeof body?.shortStrike === "number"
      ? { short: body.shortStrike, long: typeof body?.longStrike === "number" ? body.longStrike : undefined }
      : undefined;

  try {
    const trades = await getPaperTrades();
    const existing = findOpenTrade(trades, symbol, mode);

    if (existing) {
      const accessToken = requireAccessToken();
      const quotes = await batchQuote(tradeQuoteKeys(existing), accessToken);
      const mark = markToMarket(existing, quotes);
      if (!mark) {
        return NextResponse.json(
          { error: "Couldn't fetch a live quote for the existing position's option(s) right now." },
          { status: 502 }
        );
      }
      return NextResponse.json({
        isIncrease: true,
        symbol,
        direction,
        mode,
        expiry: existing.expiry,
        existingLots: existing.lots,
        existingEntryPremium: existing.entryPremium,
        underlyingPrice: mark.underlyingPrice,
        currentPremium: mark.premium,
        shortLeg: existing.shortLeg,
        longLeg: existing.longLeg,
        lotSize: existing.lotSize,
      });
    }

    const plan = await buildTradePlan(symbol, direction, mode, manualStrikes);
    return NextResponse.json({ isIncrease: false, ...plan });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to build a trade plan.";
    return NextResponse.json({ error: message }, { status: err instanceof KiteAuthError ? 401 : 400 });
  }
}
