import { getInstrumentsCsv, requireAccessToken } from "@/lib/kite";
import { parseCsv } from "@/lib/csv";

let cache: { fetchedAt: number; byKey: Map<string, number> } | null = null;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

async function loadTokens(): Promise<Map<string, number>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.byKey;
  }

  const accessToken = requireAccessToken();
  const [nseCsv, bseCsv] = await Promise.all([
    getInstrumentsCsv("NSE", accessToken),
    getInstrumentsCsv("BSE", accessToken),
  ]);

  const byKey = new Map<string, number>();
  for (const [csv, exchange] of [
    [nseCsv, "NSE"],
    [bseCsv, "BSE"],
  ] as const) {
    for (const r of parseCsv(csv)) {
      const token = Number(r.instrument_token);
      if (r.segment === exchange && r.instrument_type === "EQ") {
        byKey.set(`EQ:${r.tradingsymbol}`, token);
      } else if (r.segment === "INDICES") {
        byKey.set(`INDEX:${exchange}:${r.tradingsymbol}`, token);
      }
    }
  }

  cache = { fetchedAt: Date.now(), byKey };
  return byKey;
}

/** Instrument token for a stock's own equity listing (for historical price data). */
export async function getEquityToken(symbol: string): Promise<number | undefined> {
  const tokens = await loadTokens();
  return tokens.get(`EQ:${symbol}`);
}

/** Instrument token for an index's spot value (for historical price data). */
export async function getIndexToken(
  exchange: "NSE" | "BSE",
  tradingsymbol: string
): Promise<number | undefined> {
  const tokens = await loadTokens();
  return tokens.get(`INDEX:${exchange}:${tradingsymbol}`);
}
