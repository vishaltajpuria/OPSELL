import { NextResponse } from "next/server";
import { isConnected } from "@/lib/session";
import { requireAccessToken, KiteAuthError } from "@/lib/kite";
import { batchQuote } from "@/lib/quoteBatch";
import { tradeQuoteKeys, markToMarket, backfillCapitalRequired } from "@/lib/paperTrading";
import { getPaperTrades, savePaperTrades } from "@/lib/kv";

export const dynamic = "force-dynamic";

// The "Live" button: fetches current quotes for every OPEN trade's option
// leg(s) plus underlying spot in one batched call, and marks each trade to
// market. Also opportunistically backfills capitalRequired for any open
// trade that doesn't have one yet (predates that field, or its margin
// lookup failed at entry) — cheap since it's a no-op for trades that
// already have it. Never auto-closes anything — exits are manual only.
export async function POST() {
  if (!isConnected()) {
    return NextResponse.json({ error: "Not connected to Zerodha." }, { status: 401 });
  }

  try {
    const trades = await getPaperTrades();
    const openTrades = trades.filter((t) => t.status === "open");
    if (openTrades.length === 0) {
      return NextResponse.json({ trades, refreshedAt: new Date().toISOString(), stale: [] });
    }

    const accessToken = requireAccessToken();
    const keys = Array.from(new Set(openTrades.flatMap((t) => tradeQuoteKeys(t))));
    const quotes = await batchQuote(keys, accessToken);

    const now = new Date().toISOString();
    const stale: string[] = [];
    for (const trade of openTrades) {
      const mark = markToMarket(trade, quotes);
      if (!mark) {
        stale.push(trade.id);
        continue;
      }
      trade.lastMarkPremium = mark.premium;
      trade.lastMarkAt = now;
    }

    await Promise.all(
      openTrades
        .filter((t) => typeof t.capitalRequired !== "number")
        .map(async (t) => {
          t.capitalRequired = await backfillCapitalRequired(t, accessToken);
        })
    );

    await savePaperTrades(trades);
    return NextResponse.json({ trades, refreshedAt: now, stale });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to refresh live prices.";
    return NextResponse.json({ error: message }, { status: err instanceof KiteAuthError ? 401 : 500 });
  }
}
