import { getInstrumentsCsv, requireAccessToken } from "@/lib/kite";
import { parseCsv } from "@/lib/csv";

// Index underlyings also trade on the NFO segment; exclude them since the
// user only wants individual F&O stocks.
const INDEX_UNDERLYINGS = new Set([
  "NIFTY",
  "BANKNIFTY",
  "FINNIFTY",
  "MIDCPNIFTY",
  "NIFTYNXT50",
]);

export type FnoStock = {
  name: string;
  lotSize: number;
  expiries: string[]; // ISO yyyy-mm-dd, ascending
};

export type OptionInstrument = {
  instrumentToken: number;
  tradingsymbol: string;
  strike: number;
  optionType: "CE" | "PE";
  expiry: string;
  lotSize: number;
};

type KiteInstrument = {
  instrument_token: number;
  tradingsymbol: string;
  name: string;
  expiry: string;
  strike: number;
  lot_size: number;
  instrument_type: "CE" | "PE" | "FUT";
  segment: string;
};

let cache: { fetchedAt: number; instruments: KiteInstrument[] } | null = null;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// Cached only for this process's lifetime. On a serverless host each cold
// start refetches the multi-thousand-row dump once, which is expected.
//
// accessToken defaults to the browser session cookie (for page requests);
// the cron job has no cookie and passes its own token explicitly instead.
async function getRawInstruments(accessToken: string = requireAccessToken()): Promise<KiteInstrument[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.instruments;
  }
  const csv = await getInstrumentsCsv("NFO", accessToken);
  const rows = parseCsv(csv);
  const instruments: KiteInstrument[] = rows.map((r) => ({
    instrument_token: Number(r.instrument_token),
    tradingsymbol: r.tradingsymbol,
    name: r.name,
    expiry: r.expiry,
    strike: Number(r.strike),
    lot_size: Number(r.lot_size),
    instrument_type: r.instrument_type as "CE" | "PE" | "FUT",
    segment: r.segment,
  }));
  cache = { fetchedAt: Date.now(), instruments };
  return instruments;
}

function toIsoDate(expiry: string): string {
  return expiry.slice(0, 10);
}

export async function listFnoStocks(accessToken: string = requireAccessToken()): Promise<FnoStock[]> {
  const instruments = await getRawInstruments(accessToken);
  const byName = new Map<string, { lotSize: number; expiries: Set<string> }>();

  for (const inst of instruments) {
    if (inst.segment !== "NFO-OPT" || INDEX_UNDERLYINGS.has(inst.name)) continue;
    const entry = byName.get(inst.name) ?? { lotSize: inst.lot_size, expiries: new Set<string>() };
    entry.expiries.add(toIsoDate(inst.expiry));
    byName.set(inst.name, entry);
  }

  return Array.from(byName.entries())
    .map(([name, { lotSize, expiries }]) => ({
      name,
      lotSize,
      expiries: Array.from(expiries).sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type NearMonthFuture = {
  name: string;
  tradingsymbol: string;
  expiry: string;
  lotSize: number;
};

/** One row per underlying: its nearest-expiry (near-month) stock futures contract. */
export async function getNearMonthFutures(
  accessToken: string = requireAccessToken()
): Promise<Map<string, NearMonthFuture>> {
  const instruments = await getRawInstruments(accessToken);
  const byName = new Map<string, NearMonthFuture>();

  for (const inst of instruments) {
    if (inst.segment !== "NFO-FUT" || INDEX_UNDERLYINGS.has(inst.name)) continue;
    const expiry = toIsoDate(inst.expiry);
    const existing = byName.get(inst.name);
    if (!existing || expiry < existing.expiry) {
      byName.set(inst.name, {
        name: inst.name,
        tradingsymbol: inst.tradingsymbol,
        expiry,
        lotSize: inst.lot_size,
      });
    }
  }

  return byName;
}

export async function getOptionChainInstruments(
  symbol: string,
  expiry: string,
  accessToken: string = requireAccessToken()
): Promise<OptionInstrument[]> {
  const instruments = await getRawInstruments(accessToken);
  return instruments
    .filter(
      (inst) =>
        inst.segment === "NFO-OPT" &&
        inst.name === symbol &&
        toIsoDate(inst.expiry) === expiry
    )
    .map((inst) => ({
      instrumentToken: inst.instrument_token,
      tradingsymbol: inst.tradingsymbol,
      strike: inst.strike,
      optionType: inst.instrument_type as "CE" | "PE",
      expiry: toIsoDate(inst.expiry),
      lotSize: inst.lot_size,
    }));
}

/**
 * Every distinct options expiry date available for a symbol (ascending) —
 * works for an F&O stock name or an index's F&O underlying name (e.g.
 * "NIFTY", "BANKNIFTY") alike, since both live in the same NFO-OPT segment
 * of the instrument dump, just filtered by `name`. Includes weekly expiries
 * where they exist (indices) — callers that want monthly-only should group
 * by month and take the latest date in each (see pickMonthlyExpiry in
 * lib/paperTrading.ts) rather than assume a naive last-Thursday-of-month
 * calendar formula, since NSE shifts an expiry landing on a holiday.
 */
export async function getOptionExpiries(
  symbol: string,
  accessToken: string = requireAccessToken()
): Promise<string[]> {
  const instruments = await getRawInstruments(accessToken);
  const expiries = new Set<string>();
  for (const inst of instruments) {
    if (inst.segment === "NFO-OPT" && inst.name === symbol) {
      expiries.add(toIsoDate(inst.expiry));
    }
  }
  return Array.from(expiries).sort();
}
