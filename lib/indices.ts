import { getQuote, requireAccessToken } from "@/lib/kite";

export type IndexQuote = {
  key: string;
  label: string;
  ltp: number | null;
  changePercent: number | null;
};

// Kite's quote keys for index spot values, as opposed to their F&O
// underlying name (e.g. F&O name "BANKNIFTY" quotes as "NSE:NIFTY BANK").
const INDEX_DEFS: { key: string; label: string; quoteKey: string }[] = [
  { key: "NIFTY", label: "Nifty 50", quoteKey: "NSE:NIFTY 50" },
  { key: "BANKNIFTY", label: "Bank Nifty", quoteKey: "NSE:NIFTY BANK" },
  { key: "FINNIFTY", label: "Fin Nifty", quoteKey: "NSE:NIFTY FIN SERVICE" },
  { key: "MIDCPNIFTY", label: "Midcap Nifty", quoteKey: "NSE:NIFTY MID SELECT" },
  { key: "SENSEX", label: "Sensex", quoteKey: "BSE:SENSEX" },
];

export async function getIndexQuotes(): Promise<IndexQuote[]> {
  const accessToken = requireAccessToken();
  const quotes = await getQuote(
    INDEX_DEFS.map((d) => d.quoteKey),
    accessToken
  );

  return INDEX_DEFS.map((def) => {
    const q = quotes[def.quoteKey];
    const ltp = q?.last_price ?? null;
    const prevClose = q?.ohlc?.close ?? null;
    const changePercent =
      ltp !== null && prevClose ? ((ltp - prevClose) / prevClose) * 100 : null;
    return { key: def.key, label: def.label, ltp, changePercent };
  });
}
