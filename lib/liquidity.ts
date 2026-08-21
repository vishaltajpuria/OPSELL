import { requireAccessToken } from "@/lib/kite";
import { listFnoStocks, getNearMonthFutures } from "@/lib/instruments";
import { batchQuote } from "@/lib/quoteBatch";

export type StockLiquidity = {
  symbol: string;
  lotSize: number;
  ltp: number | null;
  changePercent: number | null;
  futuresSymbol: string | null;
  futuresExpiry: string | null;
  futuresOI: number | null;
  futuresVolume: number | null;
  liquidityScore: number | null; // 0-100, percentile blend of OI + volume; null if no futures data
  bucket: "liquid" | "illiquid";
};

// Percentile rank (0-100) of each value within the set: what fraction of the
// set this value is greater than or equal to.
function percentileRanks(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((v) => {
    let countAtOrBelow = 0;
    for (const s of sorted) if (s <= v) countAtOrBelow++;
    return (countAtOrBelow / sorted.length) * 100;
  });
}

/**
 * Ranks every F&O stock by a simple, live liquidity signal: the percentile
 * blend of its near-month futures open interest and today's futures volume,
 * computed fresh on each call from a couple of batched Kite quote requests —
 * no historical averaging job or database needed for this split.
 */
export async function getStockLiquidity(
  accessToken: string = requireAccessToken()
): Promise<StockLiquidity[]> {
  const [stocks, futuresMap] = await Promise.all([
    listFnoStocks(accessToken),
    getNearMonthFutures(accessToken),
  ]);

  const spotKeys = stocks.map((s) => `NSE:${s.name}`);
  const futureKeys = Array.from(futuresMap.values()).map((f) => `NFO:${f.tradingsymbol}`);

  const [spotQuotes, futureQuotes] = await Promise.all([
    batchQuote(spotKeys, accessToken),
    batchQuote(futureKeys, accessToken),
  ]);

  const raw = stocks.map((s) => {
    const spot = spotQuotes[`NSE:${s.name}`];
    const future = futuresMap.get(s.name);
    const futureQuote = future ? futureQuotes[`NFO:${future.tradingsymbol}`] : undefined;

    const ltp = spot?.last_price ?? null;
    const prevClose = spot?.ohlc?.close ?? null;
    const changePercent =
      ltp !== null && prevClose ? ((ltp - prevClose) / prevClose) * 100 : null;

    return {
      symbol: s.name,
      lotSize: s.lotSize,
      ltp,
      changePercent,
      futuresSymbol: future?.tradingsymbol ?? null,
      futuresExpiry: future?.expiry ?? null,
      futuresOI: futureQuote?.oi ?? null,
      futuresVolume: futureQuote?.volume ?? null,
    };
  });

  const withFutures = raw.filter((r) => r.futuresOI !== null && r.futuresVolume !== null);
  const oiRanks = percentileRanks(withFutures.map((r) => r.futuresOI as number));
  const volumeRanks = percentileRanks(withFutures.map((r) => r.futuresVolume as number));

  const scoreBySymbol = new Map<string, number>();
  withFutures.forEach((r, i) => scoreBySymbol.set(r.symbol, (oiRanks[i] + volumeRanks[i]) / 2));

  const scores = Array.from(scoreBySymbol.values()).sort((a, b) => a - b);
  const median = scores.length > 0 ? scores[Math.floor((scores.length - 1) / 2)] : 0;

  return raw
    .map((r) => {
      const liquidityScore = scoreBySymbol.get(r.symbol) ?? null;
      const bucket: StockLiquidity["bucket"] =
        liquidityScore !== null && liquidityScore >= median ? "liquid" : "illiquid";
      return { ...r, liquidityScore, bucket };
    })
    .sort((a, b) => (b.liquidityScore ?? -1) - (a.liquidityScore ?? -1));
}
