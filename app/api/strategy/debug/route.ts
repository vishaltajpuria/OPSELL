import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/lib/session";
import { getHistoricalCandles } from "@/lib/kite";
import { getEquityToken } from "@/lib/nseInstruments";
import { computeSupertrend, computeSMA } from "@/lib/indicators";

// Temporary debugging aid: dumps the last N days of raw candles alongside
// the computed Supertrend/SMA values, so results can be checked by hand
// against a real chart. Not linked from the UI.
export async function GET(request: NextRequest) {
  const accessToken = getAccessToken();
  if (!accessToken) {
    return NextResponse.json({ error: "Not connected to Zerodha." }, { status: 401 });
  }

  const symbol = request.nextUrl.searchParams.get("symbol");
  if (!symbol) {
    return NextResponse.json({ error: "symbol query param is required." }, { status: 400 });
  }

  try {
    const token = await getEquityToken(symbol, accessToken);
    if (!token) {
      return NextResponse.json({ error: `No equity instrument token found for ${symbol}.` }, { status: 404 });
    }

    const now = new Date();
    const to = now.toISOString().slice(0, 10);
    const from = new Date(now.getTime() - 500 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const candles = await getHistoricalCandles(token, "day", from, to, accessToken);
    const supertrend = computeSupertrend(candles, 14, 1);
    const sma20 = computeSMA(candles, 20);
    const sma50 = computeSMA(candles, 50);
    const sma100 = computeSMA(candles, 100);

    const last = 20;
    const rows = candles.slice(-last).map((c, idx) => {
      const i = candles.length - last + idx;
      return {
        date: c.date,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        supertrend: supertrend[i].value,
        trend: supertrend[i].trend,
        sma20: sma20[i],
        sma50: sma50[i],
        sma100: sma100[i],
      };
    });

    return NextResponse.json({
      symbol,
      instrumentToken: token,
      totalCandlesFetched: candles.length,
      firstCandleDate: candles[0]?.date,
      lastCandleDate: candles[candles.length - 1]?.date,
      last20: rows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch debug data.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
