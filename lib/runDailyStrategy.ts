import { getHistoricalCandles } from "@/lib/kite";
import { saveSignalBatch, BATCH_IDS, type BatchId, type StoredSignal } from "@/lib/kv";
import { listFnoStocks, type FnoStock } from "@/lib/instruments";
import { getEquityToken, getIndexToken } from "@/lib/nseInstruments";
import { INDEX_DEFS } from "@/lib/indices";
import { resampleTo4H } from "@/lib/indicators";
import { detectSignals } from "@/lib/strategy";
import { findNextGap } from "@/lib/gaps";
import { batchQuote } from "@/lib/quoteBatch";
import { patchTodayCandle } from "@/lib/candleFreshness";
import { runRateLimited } from "@/lib/rateLimit";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_LOOKBACK_DAYS = 500; // comfortably covers SMA200 warm-up + buffer
const HOURLY_LOOKBACK_DAYS = 380; // under Kite's 400-day cap for 60minute interval
// detectSignals' default lookback (90 bars) assumes daily bars; scaled up
// for 4H (~2 bars/day) so it covers roughly the same real-world window
// instead of quietly becoming ~45 calendar days — same reasoning as the
// backtest tool's maxHoldBars scaling.
const FOUR_HOUR_MAX_LOOKBACK_BARS = 180;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Splits the full F&O stock list into BATCH_IDS.length roughly-equal
// slices. Vercel Hobby hard-caps a function at 60s regardless of
// maxDuration, and at Kite's 3 req/sec historical-data limit the full
// ~200-stock universe takes ~60s for one timeframe pass in a single
// invocation — right at the edge of that cap, hence splitting it across
// BATCH_IDS.length (3) invocations instead, ~65-70 stocks and ~20s each,
// comfortably under budget with room for the list to grow. (An earlier
// version pre-filtered the list down to ~100 "most promising" candidates
// with lib/scanFilter.ts before fetching any candles at all, to fit in 2
// batches — dropped in favor of scanning every stock, since 3 batches
// covers the full list just as comfortably. scanFilter.ts itself is still
// used by the /api/strategy/debug/scan-rank endpoint.)
function partitionForBatch(stocks: FnoStock[], batchId: BatchId): FnoStock[] {
  const idx = BATCH_IDS.indexOf(batchId);
  const n = BATCH_IDS.length;
  const start = Math.floor((stocks.length * idx) / n);
  const end = Math.floor((stocks.length * (idx + 1)) / n);
  return stocks.slice(start, end);
}

export type StrategyRunResult = {
  date: string;
  timeframe: "1D" | "4H";
  batchId: BatchId;
  signalCount: number;
  errorCount: number;
  errors: string[];
};

/**
 * Daily-timeframe pass for one batch of the FULL F&O stock list (every
 * symbol, no pre-filtering), plus all 5 indices (indices only run
 * alongside the first batch, so they aren't fetched BATCH_IDS.length times
 * over). Shared by the daily cron and the in-app "Run now" button, which
 * calls every batch in sequence to cover the full list.
 *
 * (Stocks run on spot rather than near-month futures — that was tried and
 * reverted, since Kite's continuous=1 futures data is a raw, non-back-
 * adjusted concatenation of monthly contracts that corrupts the ATR/
 * Supertrend math over a 500-day lookback.)
 */
export async function runDailyTimeframeStrategy(
  accessToken: string,
  batchId: BatchId
): Promise<StrategyRunResult> {
  const now = new Date();
  const to = isoDate(now);
  const fromDaily = isoDate(new Date(now.getTime() - DAILY_LOOKBACK_DAYS * DAY_MS));

  const stocks = partitionForBatch(await listFnoStocks(accessToken), batchId);
  const signals: StoredSignal[] = [];
  const errors: string[] = [];

  // Kite's historical-data endpoint can still be settling today's daily
  // candle for a while after close — fetch today's live quotes up front and
  // use them to correct today's bar rather than trusting the historical
  // endpoint's still-updating record for it. See lib/candleFreshness.ts.
  const liveQuotes = await batchQuote(
    stocks.map((s) => `NSE:${s.name}`),
    accessToken
  );

  await runRateLimited(stocks, async ({ name: symbol }) => {
    try {
      const token = await getEquityToken(symbol, accessToken);
      if (!token) return;
      const rawCandles = await getHistoricalCandles(token, "day", fromDaily, to, accessToken);
      const candles = patchTodayCandle(rawCandles, liveQuotes[`NSE:${symbol}`]);
      const stockSignals = detectSignals(candles);
      if (stockSignals.length > 0) {
        // Real (non-Heikin-Ashi) price gaps — informational only, doesn't
        // affect which stocks made the cut above. Computed once per stock,
        // not per signal, since every signal for a stock shares the same
        // entryPrice/candle history.
        const nextGap = findNextGap(candles, stockSignals[0].entryPrice);
        for (const signal of stockSignals) {
          signals.push({ symbol, timeframe: "1D", ...signal, nextGap });
        }
      }
    } catch (err) {
      errors.push(`${symbol}: ${err instanceof Error ? err.message : "failed"}`);
    }
  });

  // Checkpoint save: if the indices phase below gets cut off by a function
  // timeout, this batch's stock signals aren't lost with it.
  await saveSignalBatch(to, "1D", batchId, signals);

  if (batchId === BATCH_IDS[0]) {
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
        const indexSignals = detectSignals(daily);
        if (indexSignals.length > 0) {
          const nextGap = findNextGap(daily, indexSignals[0].entryPrice);
          for (const signal of indexSignals) {
            signals.push({ symbol: def.key, timeframe: "1D", ...signal, nextGap });
          }
        }
      } catch (err) {
        errors.push(`${def.key} (1D): ${err instanceof Error ? err.message : "failed"}`);
      }
    });

    await saveSignalBatch(to, "1D", batchId, signals);
  }

  return { date: to, timeframe: "1D", batchId, signalCount: signals.length, errorCount: errors.length, errors };
}

/**
 * 4H-timeframe pass — indices only (NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY/
 * SENSEX), no F&O stocks. Resampled from 60-minute candles
 * (session-anchored: 9:15-13:15 IST, then 13:15-15:30 — see resampleTo4H).
 * Same crossover logic as the Daily pass, just faster.
 *
 * Stocks previously ran here too (batched the same way as the Daily pass,
 * across every BATCH_IDS entry), dropped to make room for the Daily pass
 * covering the FULL, unfiltered F&O stock list instead of a pre-filtered
 * subset — 5 indices is cheap enough to run entirely within one
 * invocation, so `batchId` only ever does real work for BATCH_IDS[0] now
 * (the caller still passes one for a uniform batch-aware route/cron
 * shape, but only that one call matters).
 *
 * That batch-A-only call also actively CLEARS every other BATCH_IDS
 * entry's 4H data for today, rather than just leaving them unwritten —
 * lib/kv.ts's republishMerged() unconditionally merges every BATCH_IDS ×
 * timeframe key regardless of whether anything wrote to it today, so any
 * stock signals a batch B/C 4H run had already written for today BEFORE
 * this change shipped (or from a stray old cron trigger still pointed at
 * a since-removed batch) would otherwise keep showing up merged into
 * signals:latest indefinitely, since nothing would ever overwrite that
 * specific key again.
 */
export async function run4HTimeframeStrategy(accessToken: string, batchId: BatchId): Promise<StrategyRunResult> {
  const now = new Date();
  const to = isoDate(now);
  const fromHourly = isoDate(new Date(now.getTime() - HOURLY_LOOKBACK_DAYS * DAY_MS));

  const signals: StoredSignal[] = [];
  const errors: string[] = [];

  if (batchId === BATCH_IDS[0]) {
    await runRateLimited(INDEX_DEFS, async (def) => {
      const token = await getIndexToken(def.exchange, def.tradingsymbol, accessToken);
      if (!token) return;
      try {
        const hourly = await getHistoricalCandles(token, "60minute", fromHourly, to, accessToken);
        const fourHour = resampleTo4H(hourly);
        for (const signal of detectSignals(fourHour, FOUR_HOUR_MAX_LOOKBACK_BARS)) {
          signals.push({ symbol: def.key, timeframe: "4H", ...signal, nextGap: null });
        }
      } catch (err) {
        errors.push(`${def.key} (4H): ${err instanceof Error ? err.message : "failed"}`);
      }
    });

    await saveSignalBatch(to, "4H", batchId, signals);
    for (const staleBatchId of BATCH_IDS) {
      if (staleBatchId !== batchId) await saveSignalBatch(to, "4H", staleBatchId, []);
    }
  }

  return { date: to, timeframe: "4H", batchId, signalCount: signals.length, errorCount: errors.length, errors };
}
