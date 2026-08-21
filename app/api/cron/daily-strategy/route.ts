import { NextRequest, NextResponse } from "next/server";
import { getHistoricalCandles } from "@/lib/kite";
import { getStoredAccessToken, saveDailySignals, type StoredSignal } from "@/lib/kv";
import { getStockLiquidity } from "@/lib/liquidity";
import { getEquityToken, getIndexToken } from "@/lib/nseInstruments";
import { INDEX_DEFS } from "@/lib/indices";
import { resampleTo4H } from "@/lib/indicators";
import { detectSignals } from "@/lib/strategy";

// Vercel Hobby caps function duration at 60s. With ~150-200 liquid stocks to
// scan at Kite's 3 req/sec historical-data limit, this can get close to that
// ceiling — if it starts timing out as the liquid list grows, this needs
// either a Pro plan (higher maxDuration) or splitting the run across two
// invocations.
export const maxDuration = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_LOOKBACK_DAYS = 500; // comfortably covers SMA200 warm-up + buffer
const HOURLY_LOOKBACK_DAYS = 380; // under Kite's 400-day cap for 60minute interval

// Kite's historical-data endpoint is limited to 3 requests/second; run in
// small concurrent batches rather than either serial (slow) or unbounded
// parallel (rate-limited).
const BATCH_SIZE = 3;
const BATCH_WINDOW_MS = 1000;

async function runRateLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const started = Date.now();
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    const elapsed = Date.now() - started;
    if (i + BATCH_SIZE < items.length && elapsed < BATCH_WINDOW_MS) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_WINDOW_MS - elapsed));
    }
  }
  return results;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accessToken = await getStoredAccessToken();
  if (!accessToken) {
    return NextResponse.json(
      { error: "No stored Zerodha session. Open the app and connect to Zerodha first today." },
      { status: 400 }
    );
  }

  const now = new Date();
  const to = isoDate(now);
  const fromDaily = isoDate(new Date(now.getTime() - DAILY_LOOKBACK_DAYS * DAY_MS));
  const fromHourly = isoDate(new Date(now.getTime() - HOURLY_LOOKBACK_DAYS * DAY_MS));

  const signals: StoredSignal[] = [];
  const errors: string[] = [];

  // Stocks: Daily timeframe, restricted to today's Liquid bucket.
  const liquidity = await getStockLiquidity(accessToken);
  const liquidSymbols = liquidity.filter((s) => s.bucket === "liquid").map((s) => s.symbol);

  await runRateLimited(liquidSymbols, async (symbol) => {
    try {
      const token = await getEquityToken(symbol, accessToken);
      if (!token) return;
      const candles = await getHistoricalCandles(token, "day", fromDaily, to, accessToken);
      for (const signal of detectSignals(candles)) {
        signals.push({ symbol, timeframe: "1D", ...signal });
      }
    } catch (err) {
      errors.push(`${symbol}: ${err instanceof Error ? err.message : "failed"}`);
    }
  });

  // Indices: Daily + 4H (resampled from 60-minute candles).
  await runRateLimited(INDEX_DEFS, async (def) => {
    const token = await getIndexToken(def.exchange, def.tradingsymbol, accessToken);
    if (!token) return;

    try {
      const daily = await getHistoricalCandles(token, "day", fromDaily, to, accessToken);
      for (const signal of detectSignals(daily)) {
        signals.push({ symbol: def.key, timeframe: "1D", ...signal });
      }
    } catch (err) {
      errors.push(`${def.key} (1D): ${err instanceof Error ? err.message : "failed"}`);
    }

    try {
      const hourly = await getHistoricalCandles(token, "60minute", fromHourly, to, accessToken);
      const fourHour = resampleTo4H(hourly);
      for (const signal of detectSignals(fourHour)) {
        signals.push({ symbol: def.key, timeframe: "4H", ...signal });
      }
    } catch (err) {
      errors.push(`${def.key} (4H): ${err instanceof Error ? err.message : "failed"}`);
    }
  });

  await saveDailySignals(to, signals);

  return NextResponse.json({ date: to, signalCount: signals.length, errorCount: errors.length, errors });
}
