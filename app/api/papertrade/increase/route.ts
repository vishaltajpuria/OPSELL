import { NextRequest, NextResponse } from "next/server";
import { isConnected } from "@/lib/session";
import { requireAccessToken, KiteAuthError } from "@/lib/kite";
import { batchQuote } from "@/lib/quoteBatch";
import { tradeQuoteKeys, markToMarket, weightedAveragePremium, computeMarginForQuantity, computeTodayPnl } from "@/lib/paperTrading";
import { getPaperTrades, savePaperTrades } from "@/lib/kv";

// Adds lots to an already-open position, at its EXISTING strike(s) — never
// resolves a fresh strike, since the whole point is averaging into the same
// contract you're already holding, not opening a second, possibly
// different one.
//
// Targeted by `id`, not by (symbol, mode) — more than one open position can
// now exist for the same (symbol, mode) (see /start's forceNew, for a
// deliberately separate second position at different strikes), so looking
// this up by symbol+mode alone would be ambiguous about which one gets the
// extra lots. The id always comes from a specific position the client is
// already looking at (a preview's existing-position id, or a row on the
// Positions tab), never guessed.
export async function POST(request: NextRequest) {
  if (!isConnected()) {
    return NextResponse.json({ error: "Not connected to Zerodha." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id : "";
  const addLots = typeof body?.lots === "number" && Number.isInteger(body.lots) && body.lots > 0 ? body.lots : null;
  if (!id || !addLots) {
    return NextResponse.json({ error: "id and a positive integer lots are required." }, { status: 400 });
  }

  try {
    const trades = await getPaperTrades();
    const trade = trades.find((t) => t.id === id);
    if (!trade || trade.status !== "open" || trade.lots <= 0) {
      return NextResponse.json({ error: "No open position found with that id." }, { status: 404 });
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
    const now = new Date();
    const nowIso = now.toISOString();
    trade.lastMarkPremium = mark.premium;
    trade.lastMarkAt = nowIso;
    trade.todayPnl = computeTodayPnl(trade, quotes, now);
    trade.currentUnderlyingPrice = mark.underlyingPrice;
    trade.underlyingChangeValue = mark.underlyingChangeValue;
    trade.underlyingChangePercent = mark.underlyingChangePercent;
    // Capital just changed (more lots) — log the new level so Performance's
    // capital-deployed timeline reflects the top-up at the moment it
    // happened, not just the trade's final size. Skipped if the margin
    // lookup for the new size failed (capitalRequired null) — the ledger
    // just holds its last known level rather than recording a wrong one.
    if (typeof trade.capitalRequired === "number") {
      trade.capitalHistory.push({ at: nowIso, capitalRequired: trade.capitalRequired });
    }

    await savePaperTrades(trades);
    return NextResponse.json({ trade });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to increase the position.";
    return NextResponse.json({ error: message }, { status: err instanceof KiteAuthError ? 401 : 500 });
  }
}
