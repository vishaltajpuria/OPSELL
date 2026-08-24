import { getNearMonthFutures, type FnoStock } from "@/lib/instruments";
import { batchQuote } from "@/lib/quoteBatch";
import type { Quote } from "@/lib/kite";

// Keeps even a single, unbatched pass comfortably under Vercel's 60s cap at
// Kite's 3 req/sec historical-data limit (~27s for 80 symbols, vs. ~62s for
// the full ~185-stock F&O universe) — while still covering the most liquid/
// active third-to-half of it: the segment where a reversal signal is both
// more reliable (less noise from thin trading) and actually tradable as an
// option (real open interest to sell into).
export const TOP_N = 80;

export type ScanCandidateInputs = {
  name: string;
  oi: number; // near-month futures open interest, in shares — raw, kept for debugging only
  futVolume: number; // today's near-month futures volume, in shares — raw, kept for debugging only
  oiValue: number; // oi * futures price — notional ₹ value of open interest; this is what's actually ranked
  volValue: number; // futVolume * futures price — notional ₹ value traded today; this is what's actually ranked
  pctMove: number; // today's absolute % move in the spot price
};

function percentileRanks(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((v) => {
    let countAtOrBelow = 0;
    for (const s of sorted) if (s <= v) countAtOrBelow++;
    return (countAtOrBelow / sorted.length) * 100;
  });
}

export type ScannedCandidate = ScanCandidateInputs & {
  oiPercentile: number;
  volPercentile: number;
  movePercentile: number;
  score: number;
  rank: number; // 1-based, 1 = highest score
};

/**
 * Ranks EVERY candidate (not just the survivors) by a weighted blend of
 * three cross-sectional percentiles (each stock ranked against the others
 * in the same batch, not its own history — a true "volume vs. its own
 * 20-day average" spike detector would need a stored historical baseline,
 * not attempted here):
 *  - near-month futures open interest VALUE (oi shares * futures price),
 *    40% — a liquidity floor: a reversal signal on a name with no real
 *    option liquidity isn't tradable anyway.
 *  - today's futures volume VALUE (volume shares * futures price), 30% —
 *    today's F&O trading activity.
 *  - today's absolute % move in the spot price, 30% — today's price activity.
 * OI/volume are ranked by notional ₹ value, not raw share count — NSE sets
 * each stock's lot size to target a roughly fixed contract value, so a
 * ₹11,000 stock trades in tiny lots and a ₹100 stock trades in huge ones.
 * Ranking on raw shares would systematically punish expensive, small-lot
 * names regardless of how liquid they actually are (this was a real bug:
 * Bajaj Auto, one of the most liquid single-stock F&O names on NSE, ranked
 * in the bottom 10% on raw-share OI/volume purely because of its price).
 * Volume and price movement together are the cheap, same-day proxy for
 * "something unusual is happening" (climax/exhaustion-style activity) that
 * tends to precede or accompany a genuine reversal — without needing a
 * historical baseline per stock. Returned sorted best-to-worst with rank
 * attached, so a caller can look up exactly where one stock landed and why
 * (see the debug route) rather than only getting a pass/fail cut.
 */
export function rankAllCandidates(inputs: ScanCandidateInputs[]): ScannedCandidate[] {
  const oiRanks = percentileRanks(inputs.map((r) => r.oiValue));
  const volRanks = percentileRanks(inputs.map((r) => r.volValue));
  const moveRanks = percentileRanks(inputs.map((r) => r.pctMove));

  return inputs
    .map((r, i) => ({
      ...r,
      oiPercentile: oiRanks[i],
      volPercentile: volRanks[i],
      movePercentile: moveRanks[i],
      score: 0.4 * oiRanks[i] + 0.3 * volRanks[i] + 0.3 * moveRanks[i],
    }))
    .sort((a, b) => b.score - a.score)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Same ranking, just the names of the top `topN` — what selectScanCandidates uses. */
export function rankScanCandidates(inputs: ScanCandidateInputs[], topN: number): string[] {
  return rankAllCandidates(inputs)
    .slice(0, topN)
    .map((r) => r.name);
}

/**
 * Fetches the cheap batched /quote data (spot + near-month futures) behind
 * the scan filter and shapes it into per-stock inputs — shared by
 * selectScanCandidates and the debug route, so both score every stock
 * identically.
 */
export async function computeScanInputs(stocks: FnoStock[], accessToken: string): Promise<ScanCandidateInputs[]> {
  const [futuresMap, spotQuotes] = await Promise.all([
    getNearMonthFutures(accessToken),
    batchQuote(
      stocks.map((s) => `NSE:${s.name}`),
      accessToken
    ),
  ]);
  const futureQuotes: Record<string, Quote> = await batchQuote(
    Array.from(futuresMap.values()).map((f) => `NFO:${f.tradingsymbol}`),
    accessToken
  );

  return stocks.map((s) => {
    const future = futuresMap.get(s.name);
    const futureQuote = future ? futureQuotes[`NFO:${future.tradingsymbol}`] : undefined;
    const spot = spotQuotes[`NSE:${s.name}`];
    const prevClose = spot?.ohlc?.close ?? null;
    const pctMove = spot && prevClose ? Math.abs((spot.last_price - prevClose) / prevClose) * 100 : 0;
    const oi = futureQuote?.oi ?? 0;
    const futVolume = futureQuote?.volume ?? 0;
    const futuresPrice = futureQuote?.last_price ?? 0;
    return {
      name: s.name,
      oi,
      futVolume,
      oiValue: oi * futuresPrice,
      volValue: futVolume * futuresPrice,
      pctMove,
    };
  });
}

/**
 * Narrows the full F&O stock list down to the TOP_N most promising
 * candidates for this reversal strategy, using only cheap batched /quote
 * snapshots — NOT the per-symbol historical-candle endpoint that's actually
 * responsible for the 60s budget problem this exists to solve. See
 * rankAllCandidates for the scoring itself.
 */
export async function selectScanCandidates(stocks: FnoStock[], accessToken: string): Promise<FnoStock[]> {
  if (stocks.length <= TOP_N) return stocks;

  const inputs = await computeScanInputs(stocks, accessToken);
  const byName = new Map(stocks.map((s) => [s.name, s]));
  return rankScanCandidates(inputs, TOP_N).map((name) => byName.get(name) as FnoStock);
}
