import { getHistoricalCandles } from "@/lib/kite";
import { saveWtSignalBatch, BATCH_IDS, type BatchId, type StoredWtSignal } from "@/lib/kv";
import { listFnoStocks, type FnoStock } from "@/lib/instruments";
import { getEquityToken, getIndexToken } from "@/lib/nseInstruments";
import { INDEX_DEFS } from "@/lib/indices";
import { detectWtSignals, type WtStrategySignal } from "@/lib/wtStrategy";
import { resolveAtmOption } from "@/lib/atmOption";
import { getFourHourSupertrendTrend } from "@/lib/fourHourSupertrend";
import { batchQuote } from "@/lib/quoteBatch";
import { patchTodayCandle } from "@/lib/candleFreshness";
import { runRateLimited } from "@/lib/rateLimit";

const DAY_MS = 24 * 60 * 60 * 1000;
// Daily WT itself only needs MIN_CANDLES=80 (lib/wtStrategy.ts) worth of
// warm-up, but these same daily candles now also get resampled into WEEKLY
// bars for the weeklyWtBreach check (also in lib/wtStrategy.ts) — WT's own
// warm-up (~35 bars) needs ~35 WEEKS of history this time, not 35 days, so
// the daily fetch has to reach back far enough to produce that many weekly
// bars with a comfortable margin. 450 calendar days -> ~320 trading days ->
// ~64 weekly bars, well past the ~35-bar minimum, while still staying
// lighter than the main strategy's own 500-day daily fetch. Reusing this
// same fetch (rather than a separate weekly-specific one) avoids adding any
// new Kite request per symbol at all.
const DAILY_LOOKBACK_DAYS = 450;
// Only needs enough 4H bars to warm up ATR-14 with a comfortable margin
// (see MIN_4H_BARS in lib/fourHourSupertrend.ts) — far less history than
// the main strategy's own 4H pass needs for crossover detection
// (HOURLY_LOOKBACK_DAYS=380 in lib/runDailyStrategy.ts), since this is
// just a snapshot read of the latest bar's trend, not a lookback scan.
const FOUR_HOUR_LOOKBACK_DAYS = 90;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Same even split across BATCH_IDS as lib/runDailyStrategy.ts's own
// partitionForBatch — duplicated rather than imported since that one isn't
// exported and this keeps the two daily-run pipelines independent.
function partitionForBatch(stocks: FnoStock[], batchId: BatchId): FnoStock[] {
  const idx = BATCH_IDS.indexOf(batchId);
  const n = BATCH_IDS.length;
  const start = Math.floor((stocks.length * idx) / n);
  const end = Math.floor((stocks.length * (idx + 1)) / n);
  return stocks.slice(start, end);
}

/**
 * Fetches 60-minute candles for the same instrument (reusing the token
 * already resolved for the daily candle fetch, no extra lookup) and reads
 * its current 4H Supertrend trend — see lib/fourHourSupertrend.ts. Swallows
 * any failure to null rather than losing the WT signal itself (a
 * candle-fetch hiccup for one symbol shouldn't cost the whole batch that
 * stock's otherwise-valid signal), but records it in `errors` first — a
 * silently-null 4H read used to be indistinguishable from a genuine "not
 * below/above the line" read in the UI, which made a stock like ICICIGI
 * missing its B4H tick for no visible reason impossible to tell apart from
 * a real non-match.
 */
async function resolveFourHourTrend(
  symbol: string,
  token: number,
  accessToken: string,
  errors: string[]
): Promise<"up" | "down" | null> {
  try {
    const now = new Date();
    const to = isoDate(now);
    const from = isoDate(new Date(now.getTime() - FOUR_HOUR_LOOKBACK_DAYS * DAY_MS));
    const hourly = await getHistoricalCandles(token, "60minute", from, to, accessToken);
    return getFourHourSupertrendTrend(hourly);
  } catch (err) {
    errors.push(`${symbol} (4H): ${err instanceof Error ? err.message : "failed"}`);
    return null;
  }
}

/**
 * Attaches a representative ATM/ITM option (expiry, strike, live premium,
 * bid/ask spread — see lib/atmOption.ts) and the 4H Supertrend read above to
 * a freshly detected signal. Each swallows its own failure to null rather
 * than losing the WT signal itself — an option-chain or candle-fetch
 * glitch for one symbol shouldn't cost the whole batch that stock's
 * otherwise-valid signal — but logs it to `errors` (see
 * resolveFourHourTrend above).
 *
 * Run SEQUENTIALLY, not concurrently: this whole function already runs
 * inside runRateLimited's per-symbol callback, which itself budgets for
 * exactly ONE Kite request in flight per symbol at a time (3 concurrent
 * symbols/second — see lib/rateLimit.ts) to stay under Kite's 3 req/sec
 * cap. Firing atmOption's quote call and this 4H candle call concurrently
 * would silently double that to up to 6 in-flight requests whenever
 * multiple symbols in the same rate-limited batch have signals — enough to
 * occasionally trip Kite's rate limit on one of the two calls for one
 * unlucky symbol, which is exactly what's suspected to have happened here
 * (the daily fetch that produces the signal itself succeeds, but this
 * enrichment fetch silently fails and swallows to null).
 */
async function enrichSignal(
  symbol: string,
  token: number,
  signal: WtStrategySignal,
  accessToken: string,
  errors: string[]
): Promise<StoredWtSignal> {
  const atmOption = await resolveAtmOption(symbol, signal.entryPrice, signal.direction, accessToken).catch((err) => {
    errors.push(`${symbol} (ATM option): ${err instanceof Error ? err.message : "failed"}`);
    return null;
  });
  const fourHourTrend = await resolveFourHourTrend(symbol, token, accessToken, errors);
  return { symbol, ...signal, atmOption, fourHourTrend };
}

export type WtStrategyRunResult = {
  date: string;
  batchId: BatchId;
  signalCount: number;
  errorCount: number;
  errors: string[];
};

/**
 * Daily pass for Strategy Tab 2 — one batch of the full F&O stock list (plus
 * indices, folded into batch A). Signal DETECTION runs on the Daily
 * timeframe only (no 4H crossover scan) via detectWtSignals; a symbol that
 * qualifies also gets a 4H candle fetch purely to read its current
 * Supertrend trend (see enrichSignal/resolveFourHourTrend above), an
 * informational tick, not a second detection pass. Entirely independent of
 * lib/runDailyStrategy.ts: different signal source (detectWtSignals, not
 * the Supertrend/SMA crossover), different Redis keys (see
 * saveWtSignalBatch), same batching/rate-limit/checkpoint shape reused
 * because it already solves the same Vercel-duration and Kite-rate-limit
 * constraints.
 */
export async function runDailyWtStrategy(accessToken: string, batchId: BatchId): Promise<WtStrategyRunResult> {
  const now = new Date();
  const to = isoDate(now);
  const from = isoDate(new Date(now.getTime() - DAILY_LOOKBACK_DAYS * DAY_MS));

  const stocks = partitionForBatch(await listFnoStocks(accessToken), batchId);
  const signals: StoredWtSignal[] = [];
  const errors: string[] = [];

  const liveQuotes = await batchQuote(
    stocks.map((s) => `NSE:${s.name}`),
    accessToken
  );

  await runRateLimited(stocks, async ({ name: symbol }) => {
    try {
      const token = await getEquityToken(symbol, accessToken);
      if (!token) return;
      const rawCandles = await getHistoricalCandles(token, "day", from, to, accessToken);
      const candles = patchTodayCandle(rawCandles, liveQuotes[`NSE:${symbol}`]);
      for (const signal of detectWtSignals(candles)) {
        signals.push(await enrichSignal(symbol, token, signal, accessToken, errors));
      }
    } catch (err) {
      errors.push(`${symbol}: ${err instanceof Error ? err.message : "failed"}`);
    }
  });

  // Checkpoint save: if the indices phase below gets cut off by a function
  // timeout, this batch's stock signals aren't lost with it.
  await saveWtSignalBatch(to, batchId, signals);

  if (batchId === BATCH_IDS[0]) {
    const indexLiveQuotes = await batchQuote(
      INDEX_DEFS.map((d) => `${d.exchange}:${d.tradingsymbol}`),
      accessToken
    );

    await runRateLimited(INDEX_DEFS, async (def) => {
      const token = await getIndexToken(def.exchange, def.tradingsymbol, accessToken);
      if (!token) return;
      try {
        const rawDaily = await getHistoricalCandles(token, "day", from, to, accessToken);
        const daily = patchTodayCandle(rawDaily, indexLiveQuotes[`${def.exchange}:${def.tradingsymbol}`]);
        for (const signal of detectWtSignals(daily)) {
          signals.push(await enrichSignal(def.key, token, signal, accessToken, errors));
        }
      } catch (err) {
        errors.push(`${def.key}: ${err instanceof Error ? err.message : "failed"}`);
      }
    });

    await saveWtSignalBatch(to, batchId, signals);
  }

  return { date: to, batchId, signalCount: signals.length, errorCount: errors.length, errors };
}
