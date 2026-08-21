import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/lib/session";
import { getHistoricalCandles, type Candle } from "@/lib/kite";
import { getEquityToken } from "@/lib/nseInstruments";
import { backtestSymbol, type BacktestTrade } from "@/lib/backtest";
import { toOptionTrade, type OptionTrade } from "@/lib/optionsBacktest";
import { runRateLimited } from "@/lib/rateLimit";

export const maxDuration = 60;

// ~3 years of calendar days: gives roughly 2 years of days the strategy can
// actually fire signals on, after the ~210-trading-day SMA200/Supertrend
// warm-up eats into the front of the fetched range.
const LOOKBACK_DAYS = 1100;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function POST(request: NextRequest) {
  const accessToken = getAccessToken();
  if (!accessToken) {
    return NextResponse.json({ error: "Not connected to Zerodha." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const symbols: string[] = Array.isArray(body?.symbols)
    ? Array.from(new Set(body.symbols.map((s: unknown) => String(s).trim().toUpperCase()).filter(Boolean)))
    : [];
  if (symbols.length === 0) {
    return NextResponse.json({ error: "Provide a non-empty symbols array." }, { status: 400 });
  }
  const stopLossPercent =
    typeof body?.stopLossPercent === "number" && body.stopLossPercent > 0 ? body.stopLossPercent : undefined;
  const directionFilter =
    body?.directionFilter === "short" || body?.directionFilter === "long" ? body.directionFilter : undefined;
  const sellOptions = body?.sellOptions === true;

  const now = new Date();
  const to = isoDate(now);
  const from = isoDate(new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000));

  const errors: string[] = [];

  // Batched at Kite's 3 req/sec historical-data limit (not a plain
  // sequential loop with a fixed per-request delay — that wastes time
  // waiting even after a fast response, and at 100+ symbols risks the
  // whole run creeping past Vercel Hobby's 60s function cap).
  const perSymbolResults = await runRateLimited(symbols, async (symbol) => {
    try {
      const token = await getEquityToken(symbol, accessToken);
      if (!token) {
        errors.push(`${symbol}: no equity instrument token found.`);
        return [] as BacktestTrade[] | OptionTrade[];
      }
      const candles: Candle[] = await getHistoricalCandles(token, "day", from, to, accessToken);
      const stockTrades = backtestSymbol(symbol, candles, { stopLossPercent, directionFilter });
      if (!sellOptions) return stockTrades;
      return stockTrades
        .map((t) => toOptionTrade(t, candles))
        .filter((t): t is OptionTrade => t !== null);
    } catch (err) {
      errors.push(`${symbol}: ${err instanceof Error ? err.message : "failed"}`);
      return [] as BacktestTrade[] | OptionTrade[];
    }
  });

  const trades = perSymbolResults.flat();

  return NextResponse.json({
    from,
    to,
    symbolCount: symbols.length,
    stopLossPercent: stopLossPercent ?? null,
    directionFilter: directionFilter ?? null,
    sellOptions,
    trades,
    errors,
  });
}
