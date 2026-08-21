import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/lib/session";
import { getHistoricalCandles, getQuote } from "@/lib/kite";
import { getNearMonthFutures } from "@/lib/instruments";
import { computeSupertrend, computeSMA } from "@/lib/indicators";
import { patchTodayCandle } from "@/lib/candleFreshness";

// Temporary debugging aid: dumps the last N days of raw candles alongside
// the computed Supertrend/SMA values, so results can be checked by hand
// against a real chart. Not linked from the UI. Uses the same near-month
// futures (continuous) data the actual strategy run does.
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
    const futuresMap = await getNearMonthFutures(accessToken);
    const future = futuresMap.get(symbol);
    if (!future) {
      return NextResponse.json({ error: `No near-month future found for ${symbol}.` }, { status: 404 });
    }

    const now = new Date();
    const to = now.toISOString().slice(0, 10);
    const from = new Date(now.getTime() - 500 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const rawCandles = await getHistoricalCandles(future.instrumentToken, "day", from, to, accessToken, true);
    const quoteKey = `NFO:${future.tradingsymbol}`;
    const quotes = await getQuote([quoteKey], accessToken);
    const candles = patchTodayCandle(rawCandles, quotes[quoteKey]);
    const wasPatched = rawCandles[rawCandles.length - 1]?.close !== candles[candles.length - 1]?.close;
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
      futuresTradingsymbol: future.tradingsymbol,
      futuresExpiry: future.expiry,
      instrumentToken: future.instrumentToken,
      totalCandlesFetched: candles.length,
      firstCandleDate: candles[0]?.date,
      lastCandleDate: candles[candles.length - 1]?.date,
      todayCandlePatchedFromLiveQuote: wasPatched,
      rawLastCandleCloseFromHistoricalApi: rawCandles[rawCandles.length - 1]?.close,
      patchedLastCandleClose: candles[candles.length - 1]?.close,
      last20: rows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch debug data.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
