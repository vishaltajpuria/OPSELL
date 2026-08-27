import { NextRequest, NextResponse } from "next/server";
import { isConnected } from "@/lib/session";
import { requireAccessToken, KiteAuthError } from "@/lib/kite";
import { batchQuote } from "@/lib/quoteBatch";
import { tradeQuoteKeys, markToMarket, computePartialClose, computeTodayPnl } from "@/lib/paperTrading";
import { getPaperTrades, savePaperTrades, type ClosedLot } from "@/lib/kv";

// Closes a position, in full (omit lots) or in part (pass lots < what's
// open) — either way records one ClosedLot event and, if any lots remain
// open, keeps the trade open with the remainder at its existing entry
// premium (a partial close doesn't change the average entry price of what's
// still open, only realizes P&L on the portion that's leaving).
export async function POST(request: NextRequest) {
  if (!isConnected()) {
    return NextResponse.json({ error: "Not connected to Zerodha." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id : "";
  const lotsRaw = body?.lots;
  const requestedLots =
    lotsRaw === undefined || lotsRaw === null
      ? null
      : typeof lotsRaw === "number" && Number.isInteger(lotsRaw) && lotsRaw > 0
        ? lotsRaw
        : "invalid";
  if (!id || requestedLots === "invalid") {
    return NextResponse.json({ error: "id is required; lots, if given, must be a positive integer." }, { status: 400 });
  }

  try {
    const trades = await getPaperTrades();
    const trade = trades.find((t) => t.id === id);
    if (!trade) {
      return NextResponse.json({ error: "Trade not found." }, { status: 404 });
    }
    if (trade.status !== "open" || trade.lots <= 0) {
      return NextResponse.json({ error: "Position is already fully closed." }, { status: 400 });
    }

    const accessToken = requireAccessToken();
    const quotes = await batchQuote(tradeQuoteKeys(trade), accessToken);
    const mark = markToMarket(trade, quotes);
    if (!mark) {
      return NextResponse.json({ error: "Couldn't fetch a live quote for this trade's option(s) right now." }, { status: 502 });
    }

    const lotsToClose = requestedLots ?? trade.lots; // omitted lots = close everything that's open
    const result = computePartialClose(trade, lotsToClose, mark.premium);
    const now = new Date().toISOString();
    const closedLot: ClosedLot = {
      lots: result.closedLots,
      exitPremium: mark.premium,
      exitUnderlyingPrice: mark.underlyingPrice,
      closedAt: now,
      capitalReleased: result.capitalReleased,
      pnl: result.pnl,
    };

    trade.closedLots.push(closedLot);
    trade.lots = result.remainingLots;
    trade.capitalRequired = result.remainingCapitalRequired;
    trade.status = result.remainingLots > 0 ? "open" : "closed";
    trade.lastMarkPremium = mark.premium;
    trade.lastMarkAt = now;
    trade.todayPnl = result.remainingLots > 0 ? computeTodayPnl(trade, quotes, new Date(now)) : null;
    trade.currentUnderlyingPrice = result.remainingLots > 0 ? mark.underlyingPrice : null;
    trade.underlyingChangeValue = result.remainingLots > 0 ? mark.underlyingChangeValue : null;
    trade.underlyingChangePercent = result.remainingLots > 0 ? mark.underlyingChangePercent : null;

    await savePaperTrades(trades);
    return NextResponse.json({ trade });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to close the trade.";
    return NextResponse.json({ error: message }, { status: err instanceof KiteAuthError ? 401 : 500 });
  }
}
