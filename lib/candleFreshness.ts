import type { Candle, Quote } from "@/lib/kite";

function todayIsoIst(): string {
  // Candles are dated at 00:00+05:30 for the trading day they represent, so
  // compare against today's IST calendar date, not the server's UTC date.
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/**
 * Kite's historical-data endpoint can still be settling "today's" daily
 * candle for a while after market close — confirmed on NATIONALUM on
 * 2026-08-21, where it returned a close 4-5 points off the live quote
 * (395.9 vs. ~391.15), enough to flip a Supertrend signal that shouldn't
 * have flipped. Once the market's closed, the live quote's last_price and
 * today's ohlc are authoritative; use those in place of the historical
 * endpoint's still-updating record for today's bar specifically.
 */
export function patchTodayCandle(candles: Candle[], liveQuote: Quote | undefined): Candle[] {
  if (candles.length === 0 || !liveQuote) return candles;
  const last = candles[candles.length - 1];
  if (last.date.slice(0, 10) !== todayIsoIst()) return candles;

  const patched: Candle = {
    date: last.date,
    open: liveQuote.ohlc.open,
    high: liveQuote.ohlc.high,
    low: liveQuote.ohlc.low,
    close: liveQuote.last_price,
    volume: last.volume,
  };
  return [...candles.slice(0, -1), patched];
}
