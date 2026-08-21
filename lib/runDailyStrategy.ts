import { getHistoricalCandles } from "@/lib/kite";
import { saveDailySignals, type StoredSignal } from "@/lib/kv";
import { getNearMonthFutures } from "@/lib/instruments";
import { getIndexToken } from "@/lib/nseInstruments";
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

export type StrategyRunResult = {
  date: string;
  signalCount: number;
  errorCount: number;
  errors: string[];
};

/**
 * Shared by the scheduled cron job and the in-app "Run now" button — same
 * logic, just given a different accessToken (KV-stored for the cron, the
 * browser session's for a manual run).
 */
export async function runDailyStrategy(accessToken: string): Promise<StrategyRunResult> {
  const now = new Date();
  const to = isoDate(now);
  const fromDaily = isoDate(new Date(now.getTime() - DAILY_LOOKBACK_DAYS * DAY_MS));
  const fromHourly = isoDate(new Date(now.getTime() - HOURLY_LOOKBACK_DAYS * DAY_MS));

  const signals: StoredSignal[] = [];
  const errors: string[] = [];

  // Stocks: Daily timeframe, every F&O stock's near-month FUTURES contract
  // (liquid and illiquid alike) — not the equity/spot price. Futures don't
  // have the equity market's official weighted-average closing-price
  // computation, which is the likely source of Kite's historical endpoint
  // disagreeing with the live price for a still-settling equity candle.
  // continuous=1 stitches historical data across monthly expiries into one
  // ongoing series, since a single contract only exists for ~1 month on its
  // own — nowhere near enough history to warm up SMA200.
  const futuresMap = await getNearMonthFutures(accessToken);
  const futures = Array.from(futuresMap.values());

  const liveQuotes = await batchQuote(
    futures.map((f) => `NFO:${f.tradingsymbol}`),
    accessToken
  );

  await runRateLimited(futures, async (future) => {
    try {
      const rawCandles = await getHistoricalCandles(
        future.instrumentToken,
        "day",
        fromDaily,
        to,
        accessToken,
        true
      );
      const candles = patchTodayCandle(rawCandles, liveQuotes[`NFO:${future.tradingsymbol}`]);
      for (const signal of detectSignals(candles)) {
        signals.push({ symbol: future.name, timeframe: "1D", ...signal });
      }
    } catch (err) {
      errors.push(`${future.name}: ${err instanceof Error ? err.message : "failed"}`);
    }
  });

  // Checkpoint save: if the indices phase below gets cut off by a function
  // timeout, the (much larger, slower) stocks phase isn't lost with it.
  await saveDailySignals(to, signals);

  // Indices: Daily + 4H (resampled from 60-minute candles).
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

  return { date: to, signalCount: signals.length, errorCount: errors.length, errors };
}
