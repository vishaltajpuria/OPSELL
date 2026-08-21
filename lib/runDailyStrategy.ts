import { getHistoricalCandles } from "@/lib/kite";
import { saveSignalsForTimeframe, type StoredSignal } from "@/lib/kv";
import { getStockLiquidity } from "@/lib/liquidity";
import { getEquityToken, getIndexToken } from "@/lib/nseInstruments";
import { INDEX_DEFS } from "@/lib/indices";
import { resampleTo4H } from "@/lib/indicators";
import { detectSignals } from "@/lib/strategy";
import { batchQuote } from "@/lib/quoteBatch";
import { patchTodayCandle } from "@/lib/candleFreshness";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_LOOKBACK_DAYS = 500; // comfortably covers SMA200 warm-up + buffer
const HOURLY_LOOKBACK_DAYS = 380; // under Kite's 400-day cap for 60minute interval

// Kite's historical-data endpoint is limited to 3 requests/second; run in
// small concurrent batches rather than either serial (slow) or unbounded
// parallel (rate-limited).
const BATCH_SIZE = 3;
const BATCH_WINDOW_MS = 1000;

// Vercel Hobby hard-caps a function at 60s regardless of maxDuration. At
// 3 req/sec, fetching both the Daily and 4H candles for the full ~185-stock
// F&O universe in one invocation would take well over two minutes. Two fixes
// together keep each invocation comfortably under budget: capping to the top
// N most-liquid stocks (by the same OI+volume score used for the
// Liquid/Illiquid split), and running Daily and 4H as two separate function
// invocations (see the two exported functions below) so each gets its own
// fresh 60s clock — ~120 stocks * 1 request / 3 req/sec ≈ 40s per timeframe.
const TOP_N_STOCKS_BY_LIQUIDITY = 120;

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

async function topLiquidStocks(accessToken: string) {
  const ranked = await getStockLiquidity(accessToken); // already sorted, most liquid first
  return ranked.slice(0, TOP_N_STOCKS_BY_LIQUIDITY);
}

export type StrategyRunResult = {
  date: string;
  timeframe: "1D" | "4H";
  signalCount: number;
  errorCount: number;
  errors: string[];
};

/**
 * Daily-timeframe pass: top-120 F&O stocks + all 5 indices, on spot/equity
 * price. Shared by the daily cron and the in-app "Run now" button.
 *
 * (Stocks run on spot rather than near-month futures — that was tried and
 * reverted, since Kite's continuous=1 futures data is a raw, non-back-
 * adjusted concatenation of monthly contracts that corrupts the ATR/
 * Supertrend math over a 500-day lookback.)
 */
export async function runDailyTimeframeStrategy(accessToken: string): Promise<StrategyRunResult> {
  const now = new Date();
  const to = isoDate(now);
  const fromDaily = isoDate(new Date(now.getTime() - DAILY_LOOKBACK_DAYS * DAY_MS));

  const stocks = await topLiquidStocks(accessToken);
  const signals: StoredSignal[] = [];
  const errors: string[] = [];

  // Kite's historical-data endpoint can still be settling today's daily
  // candle for a while after close — fetch today's live quotes up front and
  // use them to correct today's bar rather than trusting the historical
  // endpoint's still-updating record for it. See lib/candleFreshness.ts.
  const liveQuotes = await batchQuote(
    stocks.map((s) => `NSE:${s.symbol}`),
    accessToken
  );

  await runRateLimited(stocks, async ({ symbol }) => {
    try {
      const token = await getEquityToken(symbol, accessToken);
      if (!token) return;
      const rawCandles = await getHistoricalCandles(token, "day", fromDaily, to, accessToken);
      const candles = patchTodayCandle(rawCandles, liveQuotes[`NSE:${symbol}`]);
      for (const signal of detectSignals(candles)) {
        signals.push({ symbol, timeframe: "1D", ...signal });
      }
    } catch (err) {
      errors.push(`${symbol}: ${err instanceof Error ? err.message : "failed"}`);
    }
  });

  // Checkpoint save: if the indices phase below gets cut off by a function
  // timeout, the (much larger, slower) stocks phase isn't lost with it.
  await saveSignalsForTimeframe(to, "1D", signals);

  const indexLiveQuotes = await batchQuote(
    INDEX_DEFS.map((d) => `${d.exchange}:${d.tradingsymbol}`),
    accessToken
  );

  await runRateLimited(INDEX_DEFS, async (def) => {
    const token = await getIndexToken(def.exchange, def.tradingsymbol, accessToken);
    if (!token) return;
    try {
      const rawDaily = await getHistoricalCandles(token, "day", fromDaily, to, accessToken);
      const daily = patchTodayCandle(rawDaily, indexLiveQuotes[`${def.exchange}:${def.tradingsymbol}`]);
      for (const signal of detectSignals(daily)) {
        signals.push({ symbol: def.key, timeframe: "1D", ...signal });
      }
    } catch (err) {
      errors.push(`${def.key} (1D): ${err instanceof Error ? err.message : "failed"}`);
    }
  });

  await saveSignalsForTimeframe(to, "1D", signals);

  return { date: to, timeframe: "1D", signalCount: signals.length, errorCount: errors.length, errors };
}

/**
 * 4H-timeframe pass: top-120 F&O stocks + all 5 indices, resampled from
 * 60-minute candles (session-anchored: 9:15-13:15 IST, then 13:15-15:30 —
 * see resampleTo4H). Same crossover logic as the Daily pass, just on a
 * faster timeframe. Kept as a separate invocation from the Daily pass so
 * each stays under Vercel Hobby's 60s function cap on its own.
 */
export async function run4HTimeframeStrategy(accessToken: string): Promise<StrategyRunResult> {
  const now = new Date();
  const to = isoDate(now);
  const fromHourly = isoDate(new Date(now.getTime() - HOURLY_LOOKBACK_DAYS * DAY_MS));

  const stocks = await topLiquidStocks(accessToken);
  const signals: StoredSignal[] = [];
  const errors: string[] = [];

  await runRateLimited(stocks, async ({ symbol }) => {
    try {
      const token = await getEquityToken(symbol, accessToken);
      if (!token) return;
      const hourly = await getHistoricalCandles(token, "60minute", fromHourly, to, accessToken);
      const fourHour = resampleTo4H(hourly);
      for (const signal of detectSignals(fourHour)) {
        signals.push({ symbol, timeframe: "4H", ...signal });
      }
    } catch (err) {
      errors.push(`${symbol}: ${err instanceof Error ? err.message : "failed"}`);
    }
  });

  // Checkpoint save: same reasoning as the Daily pass above.
  await saveSignalsForTimeframe(to, "4H", signals);

  await runRateLimited(INDEX_DEFS, async (def) => {
    const token = await getIndexToken(def.exchange, def.tradingsymbol, accessToken);
    if (!token) return;
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

  await saveSignalsForTimeframe(to, "4H", signals);

  return { date: to, timeframe: "4H", signalCount: signals.length, errorCount: errors.length, errors };
}
