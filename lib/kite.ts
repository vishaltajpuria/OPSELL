import { createHash } from "node:crypto";
import { getAccessToken } from "@/lib/session";

const BASE_URL = "https://api.kite.trade";
const LOGIN_URL = "https://kite.zerodha.com/connect/login";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it in your environment (see README) before connecting to Zerodha.`
    );
  }
  return value;
}

export function getApiKey(): string {
  return requireEnv("KITE_API_KEY");
}

export function getApiSecret(): string {
  return requireEnv("KITE_API_SECRET");
}

export function getLoginUrl(): string {
  return `${LOGIN_URL}?v=3&api_key=${encodeURIComponent(getApiKey())}`;
}

export type KiteSession = { access_token: string; user_id: string };

export async function generateSession(requestToken: string): Promise<KiteSession> {
  const apiKey = getApiKey();
  const apiSecret = getApiSecret();
  // Per Kite Connect v3 docs: checksum = sha256(api_key + request_token + api_secret)
  const checksum = createHash("sha256").update(apiKey + requestToken + apiSecret).digest("hex");
  const body = new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum });

  const res = await fetch(`${BASE_URL}/session/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Kite-Version": "3" },
    body,
  });
  const json = await res.json();
  if (json.status !== "success") {
    throw new Error(json.message ?? "Failed to generate Zerodha session.");
  }
  return json.data as KiteSession;
}

export function requireAccessToken(): string {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Not connected to Zerodha yet.");
  }
  return token;
}

async function kiteGet(path: string, accessToken: string, searchParams?: URLSearchParams) {
  const url = new URL(BASE_URL + path);
  if (searchParams) url.search = searchParams.toString();
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${getApiKey()}:${accessToken}`,
      "X-Kite-Version": "3",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    let message = `Kite API error (${res.status})`;
    try {
      const j = await res.json();
      message = j.message ?? message;
    } catch {
      // response wasn't JSON (e.g. the CSV instrument dump); keep the generic message
    }
    throw new Error(message);
  }
  return res;
}

export async function getInstrumentsCsv(segment: string, accessToken: string): Promise<string> {
  const res = await kiteGet(`/instruments/${segment}`, accessToken);
  return res.text();
}

export type Quote = {
  last_price: number;
  net_change: number;
  oi: number;
  volume: number;
  ohlc: { open: number; high: number; low: number; close: number };
};

export async function getQuote(
  instruments: string[],
  accessToken: string
): Promise<Record<string, Quote>> {
  const params = new URLSearchParams();
  for (const i of instruments) params.append("i", i);
  const res = await kiteGet(`/quote`, accessToken, params);
  const json = await res.json();
  return json.data;
}

async function kitePostJson(path: string, accessToken: string, body: unknown) {
  const res = await fetch(BASE_URL + path, {
    method: "POST",
    headers: {
      Authorization: `token ${getApiKey()}:${accessToken}`,
      "X-Kite-Version": "3",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    let message = `Kite API error (${res.status})`;
    try {
      const j = await res.json();
      message = j.message ?? message;
    } catch {
      // response wasn't JSON; keep the generic message
    }
    throw new Error(message);
  }
  return res;
}

export type MarginOrder = {
  exchange: string;
  tradingsymbol: string;
  transaction_type: "BUY" | "SELL";
  variety: "regular";
  product: "NRML" | "MIS";
  order_type: "MARKET";
  quantity: number;
  price?: number;
  trigger_price?: number;
};

/**
 * Theoretical margin required for a basket of orders taken together — no
 * real order is placed. Used to size a credit spread's net capital
 * requirement: the long leg reduces margin vs. a naked short, and this is
 * the hedge-aware number Kite itself would actually block, not a manual
 * SPAN/exposure estimate. Returns null (rather than throwing) if the
 * response doesn't parse as expected, so a margin-API hiccup doesn't block
 * opening a paper trade — the caller decides how to handle "unknown."
 */
export async function getBasketMargin(orders: MarginOrder[], accessToken: string): Promise<number | null> {
  try {
    const res = await kitePostJson(`/margins/basket?consider_positions=false`, accessToken, orders);
    const json = await res.json();
    const data = json?.data;
    const ordersTotal = Array.isArray(data?.orders)
      ? data.orders.reduce((sum: number, o: { total?: number }) => sum + (o.total ?? 0), 0)
      : null;
    const total = data?.final?.total ?? data?.initial?.total ?? ordersTotal;
    return typeof total === "number" && Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

export type Candle = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export async function getHistoricalCandles(
  instrumentToken: number,
  interval: string,
  from: string,
  to: string,
  accessToken: string
): Promise<Candle[]> {
  const params = new URLSearchParams({ from, to });
  const res = await kiteGet(`/instruments/historical/${instrumentToken}/${interval}`, accessToken, params);
  const json = await res.json();
  const candles = json.data.candles as [string, number, number, number, number, number][];
  return candles.map(([date, open, high, low, close, volume]) => ({
    date,
    open,
    high,
    low,
    close,
    volume,
  }));
}
