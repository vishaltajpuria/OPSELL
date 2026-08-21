import { getInstrumentsCsv, requireAccessToken } from "@/lib/kite";
import { parseCsv } from "@/lib/csv";

let cache: { fetchedAt: number; byKey: Map<string, number> } | null = null;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// accessToken defaults to the browser session cookie (for page requests);
// the cron job has no cookie and passes its own token explicitly instead.
async function loadIndexTokens(accessToken: string = requireAccessToken()): Promise<Map<string, number>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.byKey;
  }

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
      if (r.segment === "INDICES") {
        byKey.set(`${exchange}:${r.tradingsymbol}`, Number(r.instrument_token));
      }
    }
  }

  cache = { fetchedAt: Date.now(), byKey };
  return byKey;
}

/** Instrument token for an index's spot value (for historical price data). */
export async function getIndexToken(
  exchange: "NSE" | "BSE",
  tradingsymbol: string,
  accessToken: string = requireAccessToken()
): Promise<number | undefined> {
  const tokens = await loadIndexTokens(accessToken);
  return tokens.get(`${exchange}:${tradingsymbol}`);
}
