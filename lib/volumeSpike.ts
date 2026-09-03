import type { Candle } from "@/lib/kite";

// Trailing average window, in trading days, that a spike is measured
// against.
const SPIKE_LOOKBACK_DAYS = 30;
// How many trading days after the crossover to keep watching for a spike.
const SPIKE_WINDOW_DAYS = 10;
// "At least 50% above" the trailing average.
const SPIKE_THRESHOLD = 1.5;

export type VolumeSpikeCheck = {
  // "confirmed": a qualifying spike happened within the window.
  // "not_confirmed": the full window has passed with no spike.
  // "pending": the window hasn't finished yet (a live, still-open signal) —
  // distinct from "not_confirmed" so a caller doesn't mark a 2-day-old
  // signal as failed before it's had its full 10 days to spike.
  status: "confirmed" | "not_confirmed" | "pending";
  spikeDate: string | null; // the day the spike happened, if confirmed
  spikeRatio: number | null; // that day's volume ÷ its own trailing 30-day average
};

// Trailing volume average as of index i, over the SPIKE_LOOKBACK_DAYS
// candles strictly BEFORE i — excludes i's own volume so a spike day never
// inflates the very average it's being measured against. null before
// there's a full window of history to average.
function trailingVolumeAvg(candles: Candle[], i: number): number | null {
  if (i < SPIKE_LOOKBACK_DAYS) return null;
  let sum = 0;
  for (let j = i - SPIKE_LOOKBACK_DAYS; j < i; j++) sum += candles[j].volume;
  return sum / SPIKE_LOOKBACK_DAYS;
}

/**
 * Checks whether the reversal signal that crossed over at signalIndex was
 * (or still could be) confirmed by a volume spike: at least one of the
 * SPIKE_WINDOW_DAYS trading days AFTER the crossover — not the crossover day
 * itself — saw volume at least SPIKE_THRESHOLD times that day's own trailing
 * 30-day average. This is a per-stock, own-history check (today's volume vs.
 * THIS stock's recent past), unlike lib/scanFilter.ts's cross-sectional
 * ranking (today's volume vs. every OTHER stock, used only to shrink the
 * scan universe before signals are even detected). Doesn't gate or alter
 * the crossover logic itself — purely an additional, informational read on
 * a signal that already fired.
 *
 * candles must be the same array (or a longer one) that produced the
 * signal, indexed the same way — i.e. candles[signalIndex] is the
 * crossover's own candle.
 */
export function checkVolumeSpike(candles: Candle[], signalIndex: number): VolumeSpikeCheck {
  const windowEnd = Math.min(signalIndex + SPIKE_WINDOW_DAYS, candles.length - 1);
  for (let i = signalIndex + 1; i <= windowEnd; i++) {
    const avg = trailingVolumeAvg(candles, i);
    if (avg === null || avg === 0) continue;
    const ratio = candles[i].volume / avg;
    if (ratio >= SPIKE_THRESHOLD) {
      return { status: "confirmed", spikeDate: candles[i].date, spikeRatio: ratio };
    }
  }
  const windowComplete = signalIndex + SPIKE_WINDOW_DAYS < candles.length;
  return { status: windowComplete ? "not_confirmed" : "pending", spikeDate: null, spikeRatio: null };
}
