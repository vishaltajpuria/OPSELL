import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/lib/session";
import { getHistoricalCandles, type Candle } from "@/lib/kite";
import { getEquityToken, getIndexToken } from "@/lib/nseInstruments";
import { INDEX_DEFS } from "@/lib/indices";
import { resampleTo4H, resampleTo2H } from "@/lib/indicators";
import { backtestSymbol, type BacktestTrade } from "@/lib/backtest";
import { toOptionTrade, type OptionTrade } from "@/lib/optionsBacktest";
import { runRateLimited } from "@/lib/rateLimit";

export const maxDuration = 60;

const INDEX_BY_KEY = new Map(INDEX_DEFS.map((d) => [d.key, d]));

type Timeframe = "day" | "4h" | "2h";

// ~3 years of calendar days for daily bars: gives roughly 2 years of days
// the strategy can actually fire signals on, after the ~210-bar
// SMA200/Supertrend warm-up eats into the front of the fetched range.
const DAILY_LOOKBACK_DAYS = 1100;
// Kite's historical-data endpoint caps 60minute-interval requests to ~400
// days; 380 stays under that with a safety margin. One request per symbol
// either way (matching the daily path), so this doesn't change the
// symbol-count budget — see MAX_SYMBOLS in components/BacktestRunner.tsx.
const HOURLY_LOOKBACK_DAYS = 380;

const BASE_MAX_HOLD_BARS = 90; // matches backtestSymbol's own daily default
const BASE_VOL_WINDOW_BARS = 20;
const BASE_PERIODS_PER_YEAR = 252;

const TIMEFRAME_CONFIG: Record<
  Timeframe,
  { interval: "day" | "60minute"; lookbackDays: number; resample: ((hourly: Candle[]) => Candle[]) | null; barsPerDay: number }
> = {
  day: { interval: "day", lookbackDays: DAILY_LOOKBACK_DAYS, resample: null, barsPerDay: 1 },
  // Session-anchored resample of 60-minute candles — see resampleTo4H/2H in
  // lib/indicators.ts for the exact bucketing (last bar of each day is
  // short). ~2 bars/day for 4H, ~4 bars/day for 2H.
  "4h": { interval: "60minute", lookbackDays: HOURLY_LOOKBACK_DAYS, resample: resampleTo4H, barsPerDay: 2 },
  "2h": { interval: "60minute", lookbackDays: HOURLY_LOOKBACK_DAYS, resample: resampleTo2H, barsPerDay: 4 },
};

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
  const timeframe: Timeframe = body?.timeframe === "4h" || body?.timeframe === "2h" ? body.timeframe : "day";
  const config = TIMEFRAME_CONFIG[timeframe];
  const stopLossPercent =
    typeof body?.stopLossPercent === "number" && body.stopLossPercent > 0 ? body.stopLossPercent : undefined;
  const directionFilter =
    body?.directionFilter === "short" || body?.directionFilter === "long" ? body.directionFilter : undefined;
  const sellOptions = body?.sellOptions === true;
  const spreadWidthPercent =
    typeof body?.spreadWidthPercent === "number" && body.spreadWidthPercent > 0 ? body.spreadWidthPercent : undefined;

  const now = new Date();
  const to = isoDate(now);
  const from = isoDate(new Date(now.getTime() - config.lookbackDays * 24 * 60 * 60 * 1000));

  const maxHoldBars = BASE_MAX_HOLD_BARS * config.barsPerDay;
  const volWindowBars = BASE_VOL_WINDOW_BARS * config.barsPerDay;
  const periodsPerYear = BASE_PERIODS_PER_YEAR * config.barsPerDay;

  const errors: string[] = [];

  // Batched at Kite's 3 req/sec historical-data limit (not a plain
  // sequential loop with a fixed per-request delay — that wastes time
  // waiting even after a fast response, and at 100+ symbols risks the
  // whole run creeping past Vercel Hobby's 60s function cap). Still one
  // historical request per symbol regardless of timeframe.
  const perSymbolResults = await runRateLimited(symbols, async (symbol) => {
    try {
      const indexDef = INDEX_BY_KEY.get(symbol);
      const token = indexDef
        ? await getIndexToken(indexDef.exchange, indexDef.tradingsymbol, accessToken)
        : await getEquityToken(symbol, accessToken);
      if (!token) {
        errors.push(`${symbol}: no instrument token found.`);
        return [] as BacktestTrade[] | OptionTrade[];
      }
      const rawCandles: Candle[] = await getHistoricalCandles(token, config.interval, from, to, accessToken);
      const candles = config.resample ? config.resample(rawCandles) : rawCandles;
      const stockTrades = backtestSymbol(symbol, candles, { stopLossPercent, directionFilter, maxHoldBars });
      if (!sellOptions) return stockTrades;
      return stockTrades
        .map((t) => toOptionTrade(t, candles, { spreadWidthPercent, volWindowBars, periodsPerYear }))
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
    timeframe,
    symbolCount: symbols.length,
    stopLossPercent: stopLossPercent ?? null,
    directionFilter: directionFilter ?? null,
    sellOptions,
    spreadWidthPercent: spreadWidthPercent ?? null,
    trades,
    errors,
  });
}
