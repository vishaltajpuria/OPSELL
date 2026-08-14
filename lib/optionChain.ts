import { getQuote, requireAccessToken } from "@/lib/kite";
import { getOptionChainInstruments } from "@/lib/instruments";

export type ChainRow = {
  strike: number;
  call: { tradingsymbol: string; ltp: number; oi: number; volume: number } | null;
  put: { tradingsymbol: string; ltp: number; oi: number; volume: number } | null;
};

export type OptionChain = {
  symbol: string;
  expiry: string;
  spotPrice: number | null;
  rows: ChainRow[];
};

export async function getOptionChain(symbol: string, expiry: string): Promise<OptionChain> {
  const instruments = await getOptionChainInstruments(symbol, expiry);
  if (instruments.length === 0) {
    return { symbol, expiry, spotPrice: null, rows: [] };
  }

  const accessToken = requireAccessToken();
  const quoteKeys = instruments.map((i) => `NFO:${i.tradingsymbol}`);
  const spotKey = `NSE:${symbol}`;

  const [quotes, spotQuote] = await Promise.all([
    getQuote(quoteKeys, accessToken),
    getQuote([spotKey], accessToken).catch(() => null),
  ]);

  const byStrike = new Map<number, ChainRow>();
  for (const inst of instruments) {
    const q = quotes[`NFO:${inst.tradingsymbol}`];
    const row = byStrike.get(inst.strike) ?? { strike: inst.strike, call: null, put: null };
    const leg = q
      ? { tradingsymbol: inst.tradingsymbol, ltp: q.last_price, oi: q.oi, volume: q.volume }
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
