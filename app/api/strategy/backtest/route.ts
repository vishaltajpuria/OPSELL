import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/lib/session";
import { getHistoricalCandles, type Candle } from "@/lib/kite";
import { getEquityToken, getIndexToken } from "@/lib/nseInstruments";
import { INDEX_DEFS } from "@/lib/indices";
import { resampleTo4H, resampleTo2H } from "@/lib/indicators";
import { backtestSymbol, type BacktestTrade } from "@/lib/backtest";
import { backtestRsiDip } from "@/lib/rsiDipBacktest";
import { toOptionTrade, type OptionTrade } from "@/lib/optionsBacktest";
import { runRateLimited } from "@/lib/rateLimit";

export const maxDuration = 60;

const INDEX_BY_KEY = new Map(INDEX_DEFS.map((d) => [d.key, d]));

type Timeframe = "day" | "4h" | "2h";
const ALL_TIMEFRAMES: Timeframe[] = ["day", "4h", "2h"];

type Strategy = "smaSupertrend" | "rsiDip";

// Kite's historical-data endpoint caps "day"-interval requests to ~2000
// days; 1980 stays under that with a safety margin. After the ~210-bar
// SMA200/Supertrend warm-up eats into the front of the fetched range (~300
// calendar days), this leaves roughly 4.6 years the strategy can actually
// fire signals on — as close to a genuine 5-year backtest as a single Kite
// request allows without chunking into multiple calls per symbol.
const DAILY_LOOKBACK_DAYS = 1980;
// Kite's historical-data endpoint caps 60minute-interval requests to ~400
// days; 380 stays under that with a safety margin.
const HOURLY_LOOKBACK_DAYS = 380;

const BASE_MAX_HOLD_BARS = 90; // matches backtestSymbol's own daily default
const BASE_VOL_WINDOW_BARS = 20;
const BASE_PERIODS_PER_YEAR = 252;

// One historical request per (symbol, timeframe) pair. Selecting multiple
// timeframes multiplies the request count, so the safe symbol count shrinks
// accordingly — enforced client-side (components/BacktestRunner.tsx) but
// hard-capped here too as a safety net against an oversized request.
const MAX_WORK_ITEMS = 300;

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

type TimeframedTrade = (BacktestTrade | OptionTrade) & { timeframe: Timeframe };

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
  const timeframesRaw: unknown[] = Array.isArray(body?.timeframes) ? body.timeframes : [];
  const timeframes = Array.from(new Set(timeframesRaw.filter((t): t is Timeframe => ALL_TIMEFRAMES.includes(t as Timeframe))));
  if (timeframes.length === 0) timeframes.push("day");

  const strategy: Strategy = body?.strategy === "rsiDip" ? "rsiDip" : "smaSupertrend";

  const stopLossPercent =
    typeof body?.stopLossPercent === "number" && body.stopLossPercent > 0 ? body.stopLossPercent : undefined;
  // Direction filter only means anything for smaSupertrend — the RSI dip
  // strategy is long-only by construction (there's no short signal to filter).
  const directionFilter =
    strategy === "smaSupertrend" && (body?.directionFilter === "short" || body?.directionFilter === "long")
      ? body.directionFilter
      : undefined;
  const sellOptions = body?.sellOptions === true;
  const spreadWidthPercent =
    typeof body?.spreadWidthPercent === "number" && body.spreadWidthPercent > 0 ? body.spreadWidthPercent : undefined;

  const workItems = symbols.flatMap((symbol) => timeframes.map((timeframe) => ({ symbol, timeframe })));
  if (workItems.length > MAX_WORK_ITEMS) {
    return NextResponse.json(
      {
        error: `${symbols.length} symbols × ${timeframes.length} timeframe(s) = ${workItems.length} requests, over the ${MAX_WORK_ITEMS} limit. Use fewer symbols or fewer timeframes.`,
      },
      { status: 400 }
    );
  }

  const now = new Date();
  const to = isoDate(now);

  const errors: string[] = [];

  // Batched at Kite's 3 req/sec historical-data limit (not a plain
  // sequential loop with a fixed per-request delay — that wastes time
  // waiting even after a fast response, and risks the whole run creeping
  // past Vercel Hobby's 60s function cap). One historical request per
  // (symbol, timeframe) pair.
  const perItemResults = await runRateLimited(workItems, async ({ symbol, timeframe }) => {
    try {
      const config = TIMEFRAME_CONFIG[timeframe];
      const from = isoDate(new Date(now.getTime() - config.lookbackDays * 24 * 60 * 60 * 1000));
      const indexDef = INDEX_BY_KEY.get(symbol);
      const token = indexDef
        ? await getIndexToken(indexDef.exchange, indexDef.tradingsymbol, accessToken)
        : await getEquityToken(symbol, accessToken);
      if (!token) {
        errors.push(`${symbol} (${timeframe}): no instrument token found.`);
        return [] as TimeframedTrade[];
      }
      const rawCandles: Candle[] = await getHistoricalCandles(token, config.interval, from, to, accessToken);
      const candles = config.resample ? config.resample(rawCandles) : rawCandles;
      const maxHoldBars = BASE_MAX_HOLD_BARS * config.barsPerDay;
      const stockTrades =
        strategy === "rsiDip"
          ? backtestRsiDip(symbol, candles, { stopLossPercent, maxHoldBars })
          : backtestSymbol(symbol, candles, { stopLossPercent, directionFilter, maxHoldBars });

      if (!sellOptions) {
        return stockTrades.map((t) => ({ ...t, timeframe })) as TimeframedTrade[];
      }
      const volWindowBars = BASE_VOL_WINDOW_BARS * config.barsPerDay;
      const periodsPerYear = BASE_PERIODS_PER_YEAR * config.barsPerDay;
      return stockTrades
        .map((t) => toOptionTrade(t, candles, { spreadWidthPercent, volWindowBars, periodsPerYear }))
        .filter((t): t is OptionTrade => t !== null)
        .map((t) => ({ ...t, timeframe })) as TimeframedTrade[];
    } catch (err) {
      errors.push(`${symbol} (${timeframe}): ${err instanceof Error ? err.message : "failed"}`);
      return [] as TimeframedTrade[];
    }
  });

  const trades = perItemResults.flat();

  return NextResponse.json({
    to,
    timeframes,
    strategy,
    symbolCount: symbols.length,
    stopLossPercent: stopLossPercent ?? null,
    directionFilter: directionFilter ?? null,
    sellOptions,
    spreadWidthPercent: spreadWidthPercent ?? null,
    trades,
    errors,
  });
}
