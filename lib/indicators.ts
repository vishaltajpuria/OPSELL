import type { Candle } from "@/lib/kite";

export function toHeikinAshi(candles: Candle[]): Candle[] {
  const ha: Candle[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const prev = ha[i - 1];
    const haOpen = prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);
    ha.push({ date: c.date, open: haOpen, high: haHigh, low: haLow, close: haClose, volume: c.volume });
  }
  return ha;
}

// Wilder's smoothed ATR.
function computeATR(candles: Candle[], period: number): number[] {
  const trueRange = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });

  const atr: number[] = [];
  for (let i = 0; i < trueRange.length; i++) {
    if (i < period - 1) {
      atr.push(NaN);
    } else if (i === period - 1) {
      atr.push(trueRange.slice(0, period).reduce((a, b) => a + b, 0) / period);
    } else {
      atr.push((atr[i - 1] * (period - 1) + trueRange[i]) / period);
    }
  }
  return atr;
}

export type SupertrendPoint = { value: number; trend: "up" | "down" };

// Standard ATR-based Supertrend ratchet-band algorithm. Works on whatever
// candle series it's given — callers decide whether that's real OHLC or a
// Heikin Ashi transform (see lib/strategy.ts for why HA is used there).
export function computeSupertrend(candles: Candle[], period: number, multiplier: number): SupertrendPoint[] {
  const atr = computeATR(candles, period);
  const finalUpper: number[] = [];
  const finalLower: number[] = [];
  const points: SupertrendPoint[] = [];

  for (let i = 0; i < candles.length; i++) {
    if (Number.isNaN(atr[i])) {
      finalUpper.push(NaN);
      finalLower.push(NaN);
      points.push({ value: NaN, trend: "up" });
      continue;
    }

    const c = candles[i];
    const hl2 = (c.high + c.low) / 2;
    const basicUpper = hl2 + multiplier * atr[i];
    const basicLower = hl2 - multiplier * atr[i];

    const prevUpper = finalUpper[i - 1];
    const prevLower = finalLower[i - 1];
    const prevClose = i > 0 ? candles[i - 1].close : c.close;

    const upper =
      i === 0 || Number.isNaN(prevUpper) || basicUpper < prevUpper || prevClose > prevUpper
        ? basicUpper
        : prevUpper;
    const lower =
      i === 0 || Number.isNaN(prevLower) || basicLower > prevLower || prevClose < prevLower
        ? basicLower
        : prevLower;

    finalUpper.push(upper);
    finalLower.push(lower);

    let trend: "up" | "down";
    if (i === 0) {
      trend = c.close >= lower ? "up" : "down";
    } else {
      const prevTrend = points[i - 1].trend;
      trend = prevTrend === "down" ? (c.close > upper ? "up" : "down") : c.close < lower ? "down" : "up";
    }

    points.push({ value: trend === "up" ? lower : upper, trend });
  }

  return points;
}

// Plain SMA over any numeric series, tolerant of leading NaN gaps (e.g. an
// indicator series like RSI that isn't valid until its own warm-up period
// has passed) — a window containing any NaN stays NaN rather than
// poisoning every value after it the way a running-sum approach would.
export function smaSeries(values: number[], period: number): number[] {
  const result: number[] = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1);
    if (window.some(Number.isNaN)) continue;
    result[i] = window.reduce((a, b) => a + b, 0) / period;
  }
  return result;
}

export function computeSMA(candles: Candle[], period: number): number[] {
  return smaSeries(candles.map((c) => c.close), period);
}

// Wilder's smoothed moving average (same recursion as computeATR, generalized
// to any series) — tolerant of a leading NaN (e.g. index 0 of a
// bar-to-bar change series, which has no previous bar to diff against): the
// seed average is taken over the first `period` non-NaN values, wherever
// they start.
function computeRMA(values: number[], period: number): number[] {
  const result: number[] = new Array(values.length).fill(NaN);
  let seedSum = 0;
  let seedCount = 0;
  let seeded = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) continue;
    if (!seeded) {
      seedSum += v;
      seedCount++;
      if (seedCount === period) {
        result[i] = seedSum / period;
        seeded = true;
      }
    } else {
      result[i] = (result[i - 1] * (period - 1) + v) / period;
    }
  }
  return result;
}

// Wilder's RSI: Wilder-smoothed average gain vs. average loss over `period`
// bar-to-bar changes. Matches Pine's ta.rsi()/manual up-down-rma formula,
// including its down==0/up==0 edge cases.
export function computeRSI(candles: Candle[], period: number): number[] {
  const closes = candles.map((c) => c.close);
  const changes = closes.map((c, i) => (i === 0 ? NaN : c - closes[i - 1]));
  const gains = changes.map((c) => (Number.isNaN(c) ? NaN : Math.max(c, 0)));
  const losses = changes.map((c) => (Number.isNaN(c) ? NaN : Math.max(-c, 0)));
  const up = computeRMA(gains, period);
  const down = computeRMA(losses, period);
  return up.map((u, i) => {
    const d = down[i];
    if (Number.isNaN(u) || Number.isNaN(d)) return NaN;
    if (d === 0) return 100;
    if (u === 0) return 0;
    return 100 - 100 / (1 + u / d);
  });
}

// Resamples 60-minute candles into session-anchored N-hour bars: the first
// N hourly candles of each NSE trading session (starting 9:15 IST) form one
// bar, the remainder of the session forms a shorter final bar — matching how
// charting platforms bucket intraday timeframes within a single session
// rather than using calendar-aligned blocks. N=4 gives 9:15-13:15 as bar 1
// and 13:15-15:30 as bar 2; N=2 gives four bars, the last one short.
function resampleToNHour(hourly: Candle[], n: number): Candle[] {
  const byDay = new Map<string, Candle[]>();
  for (const c of hourly) {
    const day = c.date.slice(0, 10);
    const arr = byDay.get(day) ?? [];
    arr.push(c);
    byDay.set(day, arr);
  }

  const result: Candle[] = [];
  for (const dayCandles of byDay.values()) {
    for (let i = 0; i < dayCandles.length; i += n) {
      const chunk = dayCandles.slice(i, i + n);
      result.push({
        date: chunk[0].date,
        open: chunk[0].open,
        high: Math.max(...chunk.map((c) => c.high)),
        low: Math.min(...chunk.map((c) => c.low)),
        close: chunk[chunk.length - 1].close,
        volume: chunk.reduce((sum, c) => sum + c.volume, 0),
      });
    }
  }
  return result;
}

export function resampleTo4H(hourly: Candle[]): Candle[] {
  return resampleToNHour(hourly, 4);
}

export function resampleTo2H(hourly: Candle[]): Candle[] {
  return resampleToNHour(hourly, 2);
}
