import { NextRequest, NextResponse } from "next/server";
import { isConnected } from "@/lib/session";
import { requireAccessToken } from "@/lib/kite";
import { batchQuote } from "@/lib/quoteBatch";
import { tradeQuoteKeys, markToMarket } from "@/lib/paperTrading";
import { getPaperTrades, savePaperTrades } from "@/lib/kv";

export async function POST(request: NextRequest) {
  if (!isConnected()) {
    return NextResponse.json({ error: "Not connected to Zerodha." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) {
    return NextResponse.json({ error: "id is required." }, { status: 400 });
  }

  try {
    const trades = await getPaperTrades();
    const trade = trades.find((t) => t.id === id);
    if (!trade) {
      return NextResponse.json({ error: "Trade not found." }, { status: 404 });
    }
    if (trade.status !== "open") {
      return NextResponse.json({ error: "Trade is already closed." }, { status: 400 });
    }

    const accessToken = requireAccessToken();
    const quotes = await batchQuote(tradeQuoteKeys(trade), accessToken);
    const mark = markToMarket(trade, quotes);
    if (!mark) {
      return NextResponse.json({ error: "Couldn't fetch a live quote for this trade's option(s) right now." }, { status: 502 });
    }

    trade.status = "closed";
    trade.exitAt = new Date().toISOString();
    trade.exitPremium = mark.premium;
    trade.exitUnderlyingPrice = mark.underlyingPrice;
    trade.lastMarkPremium = mark.premium;
    trade.lastMarkAt = trade.exitAt;

    await savePaperTrades(trades);
    return NextResponse.json({ trade });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to close the trade.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
