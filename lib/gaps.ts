import type { Candle } from "@/lib/kite";

export type GapInfo = {
  price: number; // the price level marking the near edge of the gap — where price would need to trade back to in order to "fill" it
  percent: number; // signed distance from the reference price: positive = gap sits above it, negative = below
};

/**
 * Finds the nearest still-unfilled real price gap (raw OHLC, NOT Heikin
 * Ashi — the strategy's own crossover detection runs on Heikin Ashi
 * candles, but a gap is a real market phenomenon, empty space nobody
 * actually traded through) to `currentPrice`, informational only — this
 * never feeds into or filters the strategy's own signals.
 *
 * A gap exists between two adjacent candles when their ranges don't
 * overlap at all: a gap up when a candle's low sits entirely above the
 * previous candle's high, a gap down when its high sits entirely below the
 * previous candle's low. It's "filled" the first time any LATER candle
 * trades back into that empty zone — once that happens the gap has done
 * what a gap is expected to do, so only ones price hasn't yet revisited are
 * candidates. (A gap can only be examined once its subsequent history is
 * known, so the very latest candle can't itself be checked for filling —
 * it's simply unfilled by definition, having had no time to be revisited.)
 *
 * Returns null if there's no unfilled gap within maxPercent of
 * currentPrice (default 20%) — a gap that far away isn't a near-term level
 * worth surfacing.
 */
export function findNextGap(candles: Candle[], currentPrice: number, maxPercent = 20): GapInfo | null {
  let best: GapInfo | null = null;

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];

    let lowerBound: number;
    let upperBound: number;
    let edgePrice: number;
    let isFilledBy: (c: Candle) => boolean;

    if (cur.low > prev.high) {
      // Gap up: empty zone (prev.high, cur.low) — filled once a later
      // candle trades back down into it.
      lowerBound = prev.high;
      upperBound = cur.low;
      edgePrice = prev.high;
      isFilledBy = (c) => c.low <= lowerBound;
    } else if (cur.high < prev.low) {
      // Gap down: empty zone (cur.high, prev.low) — filled once a later
      // candle trades back up into it.
      lowerBound = cur.high;
      upperBound = prev.low;
      edgePrice = prev.low;
      isFilledBy = (c) => c.high >= upperBound;
    } else {
      continue; // no gap between these two candles
    }

    let filled = false;
    for (let j = i + 1; j < candles.length; j++) {
      if (isFilledBy(candles[j])) {
        filled = true;
        break;
      }
    }
    if (filled) continue;

    const percent = ((edgePrice - currentPrice) / currentPrice) * 100;
    if (Math.abs(percent) > maxPercent) continue;
    if (!best || Math.abs(percent) < Math.abs(best.percent)) {
      best = { price: edgePrice, percent };
    }
  }

  return best;
}
