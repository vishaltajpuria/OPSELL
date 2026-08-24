import { getNearMonthFutures, type FnoStock } from "@/lib/instruments";
import { batchQuote } from "@/lib/quoteBatch";
import type { Quote } from "@/lib/kite";

// Keeps even a single, unbatched pass comfortably under Vercel's 60s cap at
// Kite's 3 req/sec historical-data limit (~27s for 80 symbols, vs. ~62s for
// the full ~185-stock F&O universe) — while still covering the most liquid/
// active third-to-half of it: the segment where a reversal signal is both
// more reliable (less noise from thin trading) and actually tradable as an
// option (real open interest to sell into).
const TOP_N = 80;

export type ScanCandidateInputs = {
  name: string;
  oi: number; // near-month futures open interest, 0 if no futures data
  futVolume: number; // today's near-month futures volume, 0 if no futures data
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

/**
 * Ranks candidates by a weighted blend of three cross-sectional percentiles
 * (each stock ranked against the others in the same batch, not its own
 * history — a true "volume vs. its own 20-day average" spike detector would
 * need a stored historical baseline, not attempted here) and returns the
 * top `topN`:
 *  - near-month futures open interest, 40% — a liquidity floor: a reversal
 *    signal on a name with no real option liquidity isn't tradable anyway.
 *  - today's futures volume, 30% — today's F&O trading activity.
 *  - today's absolute % move in the spot price, 30% — today's price activity.
 * Volume and price movement together are the cheap, same-day proxy for
 * "something unusual is happening" (climax/exhaustion-style activity) that
 * tends to precede or accompany a genuine reversal — without needing a
 * historical baseline per stock.
 */
export function rankScanCandidates(inputs: ScanCandidateInputs[], topN: number): string[] {
  const oiRanks = percentileRanks(inputs.map((r) => r.oi));
  const volRanks = percentileRanks(inputs.map((r) => r.futVolume));
  const moveRanks = percentileRanks(inputs.map((r) => r.pctMove));

  return inputs
    .map((r, i) => ({ name: r.name, score: 0.4 * oiRanks[i] + 0.3 * volRanks[i] + 0.3 * moveRanks[i] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((r) => r.name);
}

/**
 * Narrows the full F&O stock list down to the TOP_N most promising
 * candidates for this reversal strategy, using only cheap batched /quote
 * snapshots (one call for spot, one for futures) — NOT the per-symbol
 * historical-candle endpoint that's actually responsible for the 60s
 * budget problem this exists to solve. See rankScanCandidates for the
 * scoring itself.
 */
export async function selectScanCandidates(stocks: FnoStock[], accessToken: string): Promise<FnoStock[]> {
  if (stocks.length <= TOP_N) return stocks;

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

  const inputs: ScanCandidateInputs[] = stocks.map((s) => {
    const future = futuresMap.get(s.name);
    const futureQuote = future ? futureQuotes[`NFO:${future.tradingsymbol}`] : undefined;
    const spot = spotQuotes[`NSE:${s.name}`];
    const prevClose = spot?.ohlc?.close ?? null;
    const pctMove = spot && prevClose ? Math.abs((spot.last_price - prevClose) / prevClose) * 100 : 0;
    return {
      name: s.name,
      oi: futureQuote?.oi ?? 0,
      futVolume: futureQuote?.volume ?? 0,
      pctMove,
    };
  });

  const byName = new Map(stocks.map((s) => [s.name, s]));
  return rankScanCandidates(inputs, TOP_N).map((name) => byName.get(name) as FnoStock);
}
