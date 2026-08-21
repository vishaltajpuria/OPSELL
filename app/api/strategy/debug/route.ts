import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/lib/session";
import { getHistoricalCandles, getQuote } from "@/lib/kite";
import { getEquityToken } from "@/lib/nseInstruments";
import { computeSupertrend, computeSMA, toHeikinAshi } from "@/lib/indicators";
import { patchTodayCandle } from "@/lib/candleFreshness";

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

    const rawCandles = await getHistoricalCandles(token, "day", from, to, accessToken);
    const quotes = await getQuote([`NSE:${symbol}`], accessToken);
    const candles = patchTodayCandle(rawCandles, quotes[`NSE:${symbol}`]);
    const wasPatched = rawCandles[rawCandles.length - 1]?.close !== candles[candles.length - 1]?.close;

    // Supertrend and SMA are computed on Heikin Ashi candles, matching how
    // TradingView plots them when its chart's candle type is set to Heikin
    // Ashi (its built-in Supertrend/MA scripts read the HA-transformed OHLC
    // in that mode, not the real market prices).
    const heikinAshi = toHeikinAshi(candles);
    const supertrend = computeSupertrend(heikinAshi, 14, 1);
    const sma20 = computeSMA(heikinAshi, 20);
    const sma50 = computeSMA(heikinAshi, 50);
    const sma100 = computeSMA(heikinAshi, 100);

    // Scan the FULL series (not just the last 20 rows below) for day-over-day
    // jumps that look like an unadjusted stock split/bonus rather than normal
    // volatility: a big overnight gap where the new day's whole range sits
    // outside the previous day's range (a real gap-up/down still overlaps or
    // sits just beyond the prior close; a split/bonus divides the price by a
    // clean ratio like 2, 3, 5, 10 with no such continuity).
    const corporateActionCandidates: {
      date: string;
      prevDate: string;
      prevClose: number;
      open: number;
      changePct: number;
      approxRatio: number;
    }[] = [];
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1];
      const cur = candles[i];
      if (prev.close <= 0) continue;
      const changePct = ((cur.open - prev.close) / prev.close) * 100;
      if (Math.abs(changePct) < 15) continue;
      // Ignore ordinary large gaps: a real gap still has some overlap or near-overlap
      // with the prior day's range. A split/bonus produces a clean-ish ratio.
      const ratio = prev.close / cur.open;
      const nearestWholeRatio = Math.round(ratio);
      const looksLikeCleanRatio =
        nearestWholeRatio >= 2 && Math.abs(ratio - nearestWholeRatio) / nearestWholeRatio < 0.05;
      const inverseRatio = cur.open / prev.close;
      const nearestWholeInverse = Math.round(inverseRatio);
      const looksLikeCleanInverse =
        nearestWholeInverse >= 2 && Math.abs(inverseRatio - nearestWholeInverse) / nearestWholeInverse < 0.05;
      if (Math.abs(changePct) >= 15 && (looksLikeCleanRatio || looksLikeCleanInverse || Math.abs(changePct) >= 30)) {
        corporateActionCandidates.push({
          date: cur.date,
          prevDate: prev.date,
          prevClose: prev.close,
          open: cur.open,
          changePct: Math.round(changePct * 100) / 100,
          approxRatio: looksLikeCleanRatio ? nearestWholeRatio : looksLikeCleanInverse ? 1 / nearestWholeInverse : 0,
        });
      }
    }

    const last = 20;
    const rows = candles.slice(-last).map((c, idx) => {
      const i = candles.length - last + idx;
      const ha = heikinAshi[i];
      return {
        date: c.date,
        close: c.close,
        haOpen: ha.open,
        haHigh: ha.high,
        haLow: ha.low,
        haClose: ha.close,
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
      todayCandlePatchedFromLiveQuote: wasPatched,
      rawLastCandleCloseFromHistoricalApi: rawCandles[rawCandles.length - 1]?.close,
      patchedLastCandleClose: candles[candles.length - 1]?.close,
      possibleUnadjustedCorporateActions: corporateActionCandidates,
      last20: rows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch debug data.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
