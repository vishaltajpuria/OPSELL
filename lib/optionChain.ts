import { getQuote, requireAccessToken } from "@/lib/kite";
import { getOptionChainInstruments } from "@/lib/instruments";
import { INDEX_DEFS } from "@/lib/indices";

const INDEX_BY_KEY = new Map(INDEX_DEFS.map((d) => [d.key, d]));

export type ChainLeg = { tradingsymbol: string; ltp: number; oi: number; volume: number; lotSize: number };

export type ChainRow = {
  strike: number;
  call: ChainLeg | null;
  put: ChainLeg | null;
};

export type OptionChain = {
  symbol: string;
  expiry: string;
  spotPrice: number | null;
  rows: ChainRow[];
};

// Spot quote key differs from the F&O underlying name for indices — e.g.
// F&O name "BANKNIFTY" quotes as "NSE:NIFTY BANK", not "NSE:BANKNIFTY". A
// plain stock's spot key is just its own name on NSE.
export function spotQuoteKey(symbol: string): string {
  const indexDef = INDEX_BY_KEY.get(symbol);
  return indexDef ? `${indexDef.exchange}:${indexDef.tradingsymbol}` : `NSE:${symbol}`;
}

export async function getOptionChain(symbol: string, expiry: string): Promise<OptionChain> {
  const instruments = await getOptionChainInstruments(symbol, expiry);
  if (instruments.length === 0) {
    return { symbol, expiry, spotPrice: null, rows: [] };
  }

  const accessToken = requireAccessToken();
  const quoteKeys = instruments.map((i) => `NFO:${i.tradingsymbol}`);
  const spotKey = spotQuoteKey(symbol);

  const [quotes, spotQuote] = await Promise.all([
    getQuote(quoteKeys, accessToken),
    getQuote([spotKey], accessToken).catch(() => null),
  ]);

  const byStrike = new Map<number, ChainRow>();
  for (const inst of instruments) {
    const q = quotes[`NFO:${inst.tradingsymbol}`];
    const row = byStrike.get(inst.strike) ?? { strike: inst.strike, call: null, put: null };
    const leg: ChainLeg | null = q
      ? { tradingsymbol: inst.tradingsymbol, ltp: q.last_price, oi: q.oi, volume: q.volume, lotSize: inst.lotSize }
      : null;
    if (inst.optionType === "CE") row.call = leg;
    else row.put = leg;
    byStrike.set(inst.strike, row);
  }

  const spotPrice = spotQuote?.[spotKey]?.last_price ?? null;

  return {
    symbol,
    expiry,
    spotPrice,
    rows: Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike),
  };
}
