import { NextRequest, NextResponse } from "next/server";
import { isConnected } from "@/lib/session";
import { requireAccessToken, KiteAuthError } from "@/lib/kite";
import { batchQuote } from "@/lib/quoteBatch";
import {
  findOpenTrade,
  tradeQuoteKeys,
  markToMarket,
  weightedAveragePremium,
  computeMarginForQuantity,
  computeTodayPnl,
} from "@/lib/paperTrading";
import { getPaperTrades, savePaperTrades } from "@/lib/kv";

// Adds lots to an already-open position, at its EXISTING strike(s) — never
// resolves a fresh strike, since the whole point is averaging into the same
// contract you're already holding, not opening a second, possibly
// different one.
export async function POST(request: NextRequest) {
  if (!isConnected()) {
    return NextResponse.json({ error: "Not connected to Zerodha." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const symbol = typeof body?.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const mode = body?.mode === "buy" || body?.mode === "sell" ? body.mode : null;
  const addLots = typeof body?.lots === "number" && Number.isInteger(body.lots) && body.lots > 0 ? body.lots : null;
  if (!symbol || !mode || !addLots) {
    return NextResponse.json({ error: "symbol, mode ('buy'|'sell'), and a positive integer lots are required." }, { status: 400 });
  }

  try {
    const trades = await getPaperTrades();
    const trade = findOpenTrade(trades, symbol, mode);
    if (!trade) {
      return NextResponse.json({ error: `No open ${mode} position on ${symbol} to add to.` }, { status: 404 });
    }

    const accessToken = requireAccessToken();
    const quotes = await batchQuote(tradeQuoteKeys(trade), accessToken);
    const mark = markToMarket(trade, quotes);
    if (!mark) {
      return NextResponse.json({ error: "Couldn't fetch a live quote for this position's option(s) right now." }, { status: 502 });
    }

    const newLots = trade.lots + addLots;
    trade.entryPremium = weightedAveragePremium(trade.entryPremium, trade.lots, mark.premium, addLots);
    trade.lots = newLots;
    trade.capitalRequired = await computeMarginForQuantity(trade, newLots, accessToken);
    trade.lastMarkPremium = mark.premium;
    trade.lastMarkAt = new Date().toISOString();
    trade.todayPnl = computeTodayPnl(trade, quotes, new Date());

    await savePaperTrades(trades);
    return NextResponse.json({ trade });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to increase the position.";
    return NextResponse.json({ error: message }, { status: err instanceof KiteAuthError ? 401 : 500 });
  }
}
