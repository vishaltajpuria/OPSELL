import { getQuote, requireAccessToken } from "@/lib/kite";

export type IndexQuote = {
  key: string;
  label: string;
  ltp: number | null;
  changePercent: number | null;
};

export type IndexDef = {
  key: string;
  label: string;
  exchange: "NSE" | "BSE";
  tradingsymbol: string;
};

// Kite's quote/instrument identifiers for index spot values, as opposed to
// their F&O underlying name (e.g. F&O name "BANKNIFTY" quotes as "NSE:NIFTY BANK").
export const INDEX_DEFS: IndexDef[] = [
  { key: "NIFTY", label: "Nifty 50", exchange: "NSE", tradingsymbol: "NIFTY 50" },
  { key: "BANKNIFTY", label: "Bank Nifty", exchange: "NSE", tradingsymbol: "NIFTY BANK" },
  { key: "FINNIFTY", label: "Fin Nifty", exchange: "NSE", tradingsymbol: "NIFTY FIN SERVICE" },
  { key: "MIDCPNIFTY", label: "Midcap Nifty", exchange: "NSE", tradingsymbol: "NIFTY MID SELECT" },
  { key: "SENSEX", label: "Sensex", exchange: "BSE", tradingsymbol: "SENSEX" },
];

export async function getIndexQuotes(): Promise<IndexQuote[]> {
  const accessToken = requireAccessToken();
  const quotes = await getQuote(
    INDEX_DEFS.map((d) => `${d.exchange}:${d.tradingsymbol}`),
    accessToken
  );

  return INDEX_DEFS.map((def) => {
    const q = quotes[`${def.exchange}:${def.tradingsymbol}`];
    const ltp = q?.last_price ?? null;
    const prevClose = q?.ohlc?.close ?? null;
    const changePercent =
      ltp !== null && prevClose ? ((ltp - prevClose) / prevClose) * 100 : null;
    return { key: def.key, label: def.label, ltp, changePercent };
  });
}
