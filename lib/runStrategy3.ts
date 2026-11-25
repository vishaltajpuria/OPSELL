import { getHistoricalCandles } from "@/lib/kite";
import { saveStrategy3Batch, BATCH_IDS, type BatchId, type StoredStrategy3Signal } from "@/lib/kv";
import { listFnoStocks, getNearMonthFutures, type FnoStock, type NearMonthFuture } from "@/lib/instruments";
import { getEquityToken } from "@/lib/nseInstruments";
import { detectStrategy3Signal } from "@/lib/strategy3";
import { getFourHourSupertrendStreak } from "@/lib/fourHourSupertrend";
import { resolveAtmOption } from "@/lib/atmOption";
import { checkFuturesVolumeAccumulation } from "@/lib/futuresVolume";
import { batchQuote } from "@/lib/quoteBatch";
import { patchTodayCandle } from "@/lib/candleFreshness";
import { runRateLimited } from "@/lib/rateLimit";

const DAY_MS = 24 * 60 * 60 * 1000;
// Same reasoning as lib/runWtStrategy.ts's own DAILY_LOOKBACK_DAYS: the
// weekly Supertrend read needs ~35 WEEKLY bars of warm-up (not days), so
// the daily fetch has to reach back far enough to produce that many weekly
// bars with a comfortable margin.
const DAILY_LOOKBACK_DAYS = 450;
// Same as lib/runWtStrategy.ts's FOUR_HOUR_LOOKBACK_DAYS.
const FOUR_HOUR_LOOKBACK_DAYS = 90;
// ~3 months of daily futures candles (BASELINE_TRADING_DAYS in
// lib/futuresVolume.ts) plus the recent few-day window, with a margin for
// weekends/holidays. A near-month contract is only ever listed ~3 months
// before its own expiry, so this can still come back short for a
// contract that only recently rolled into "near month" — handled by
// checkFuturesVolumeAccumulation's own length guard, not an error here.
const FUTURES_LOOKBACK_DAYS = 120;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Same even split across BATCH_IDS as lib/runDailyStrategy.ts's own
// partitionForBatch — duplicated rather than imported since that one isn't
// exported and this keeps the three daily-run pipelines independent.
function partitionForBatch(stocks: FnoStock[], batchId: BatchId): FnoStock[] {
  const idx = BATCH_IDS.indexOf(batchId);
  const n = BATCH_IDS.length;
  const start = Math.floor((stocks.length * idx) / n);
  const end = Math.floor((stocks.length * (idx + 1)) / n);
  return stocks.slice(start, end);
}

/**
 * Fetches daily candles for the stock's own near-month futures contract
 * (a SEPARATE instrument from its equity listing — see
 * getNearMonthFutures in lib/instruments.ts) and runs the "whales
 * accumulating" check on them — see lib/futuresVolume.ts. Swallows any
 * failure to null rather than losing the Strategy 3 signal itself, but
 * records it in `errors` first, same reasoning as every other enrichment
 * step in this codebase (see lib/runWtStrategy.ts).
 */
async function resolveVolumeAccumulation(
  symbol: string,
  futuresMap: Map<string, NearMonthFuture>,
  accessToken: string,
  errors: string[]
) {
  const future = futuresMap.get(symbol);
  if (!future) return null;
  try {
    const now = new Date();
    const to = isoDate(now);
    const from = isoDate(new Date(now.getTime() - FUTURES_LOOKBACK_DAYS * DAY_MS));
    const futuresCandles = await getHistoricalCandles(future.instrumentToken, "day", from, to, accessToken);
    return checkFuturesVolumeAccumulation(futuresCandles);
  } catch (err) {
    errors.push(`${symbol} (futures volume): ${err instanceof Error ? err.message : "failed"}`);
    return null;
  }
}

export type Strategy3RunResult = {
  date: string;
  batchId: BatchId;
  signalCount: number;
  errorCount: number;
  errors: string[];
};

/**
 * Daily pass for Strategy Tab 3 — one batch of the full F&O stock list (no
 * indices this time, per "all fno stocks"). Unlike Strategy Tab 2, 4H is
 * part of the GATE itself here, not an after-the-fact tick — so every
 * stock needs its own 60-minute candle fetch up front, not just ones that
 * already qualified on a cheaper first pass. The two candle fetches
 * (daily, then 60-minute) run SEQUENTIALLY per symbol, same rate-limit
 * safety reasoning as lib/runWtStrategy.ts's enrichSignal: this callback
 * already runs under runRateLimited's one-request-in-flight-per-symbol
 * budget, and firing extra requests concurrently would silently exceed
 * Kite's 3 req/sec cap whenever multiple symbols in the same batch are
 * both mid-fetch.
 */
export async function runStrategy3(accessToken: string, batchId: BatchId): Promise<Strategy3RunResult> {
  const now = new Date();
  const to = isoDate(now);
  const fromDaily = isoDate(new Date(now.getTime() - DAILY_LOOKBACK_DAYS * DAY_MS));
  const fromHourly = isoDate(new Date(now.getTime() - FOUR_HOUR_LOOKBACK_DAYS * DAY_MS));

  const stocks = partitionForBatch(await listFnoStocks(accessToken), batchId);
  // listFnoStocks already reads from the same cached instrument dump this
  // reuses, so this adds no extra fetch of its own.
  const futuresMap = await getNearMonthFutures(accessToken);

  const signals: StoredStrategy3Signal[] = [];
  const errors: string[] = [];

  const liveQuotes = await batchQuote(
    stocks.map((s) => `NSE:${s.name}`),
    accessToken
  );

  await runRateLimited(stocks, async ({ name: symbol }) => {
    try {
      const token = await getEquityToken(symbol, accessToken);
      if (!token) return;

      const rawDaily = await getHistoricalCandles(token, "day", fromDaily, to, accessToken);
      const dailyCandles = patchTodayCandle(rawDaily, liveQuotes[`NSE:${symbol}`]);

      const hourlyCandles = await getHistoricalCandles(token, "60minute", fromHourly, to, accessToken);
      const fourHourStreak = getFourHourSupertrendStreak(hourlyCandles);

      const signal = detectStrategy3Signal(dailyCandles, fourHourStreak);
      if (!signal) return;

      const atmOption = await resolveAtmOption(symbol, signal.entryPrice, signal.direction, accessToken).catch((err) => {
        errors.push(`${symbol} (ATM option): ${err instanceof Error ? err.message : "failed"}`);
        return null;
      });
      const volumeAccumulation = await resolveVolumeAccumulation(symbol, futuresMap, accessToken, errors);

      signals.push({ symbol, ...signal, atmOption, volumeAccumulation });
    } catch (err) {
      errors.push(`${symbol}: ${err instanceof Error ? err.message : "failed"}`);
    }
  });

  await saveStrategy3Batch(to, batchId, signals);
  return { date: to, batchId, signalCount: signals.length, errorCount: errors.length, errors };
}
