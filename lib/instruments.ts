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
async function getRawInstruments(): Promise<KiteInstrument[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.instruments;
  }
  const csv = await getInstrumentsCsv("NFO", requireAccessToken());
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

export async function listFnoStocks(): Promise<FnoStock[]> {
  const instruments = await getRawInstruments();
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
export async function getNearMonthFutures(): Promise<Map<string, NearMonthFuture>> {
  const instruments = await getRawInstruments();
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
  expiry: string
): Promise<OptionInstrument[]> {
  const instruments = await getRawInstruments();
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
    }));
}
