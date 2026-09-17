import { redirect } from "next/navigation";
import { isConnected } from "@/lib/session";
import { getLatestWtSignals, type StoredWtSignal } from "@/lib/kv";
import RunWtStrategyButton from "@/components/RunWtStrategyButton";

export const dynamic = "force-dynamic";

function fmt(n: number) {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

// Candle dates carry a full ISO timestamp (daily candles are all midnight
// IST, so the time part is never meaningful) — trimmed to just the calendar
// date for display, per "time not needed."
function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

// Amber badge, same meaning and color as the main Strategy tab's — a
// same-direction volume spike within its own recent history (see
// lib/volumeSpike.ts). Purely factual, not a verdict on strength: your own
// backtest of the main strategy showed a volume spike does NOT reliably
// make a signal stronger, so this is shown for you to judge, not to imply
// "confirmed = better."
function volumeTick(s: StoredWtSignal) {
  if (s.volumeSpike.status !== "confirmed") return null;
  return (
    <span
      className="text-[9px] font-semibold uppercase text-amber-400"
      title={`Volume spike ${s.volumeSpike.spikeRatio?.toFixed(1)}x the 30-day average on ${dateOnly(s.volumeSpike.spikeDate ?? "")}`}
    >
      Vol ✓
    </span>
  );
}

// Violet tick, same color as the main Strategy tab's DWT badge — WT is the
// only gate here (see lib/wtStrategy.ts), so this just flags that the
// stronger breach-recover-breach pattern ALSO happened, same role as the
// volume tick above.
function doubleWtTick(s: StoredWtSignal) {
  if (!s.hasDoubleWt) return null;
  return (
    <span className="text-[9px] font-semibold uppercase text-violet-400" title={`Double WT confirmed on ${dateOnly(s.dwtDate ?? "")}`}>
      DWT ✓
    </span>
  );
}

// Whether the 4H Supertrend read (lib/fourHourSupertrend.ts) is the
// noteworthy one for THIS signal's own direction — a long signal's faster
// timeframe hasn't turned bullish yet (still "down", B4H), a short's
// hasn't turned bearish yet (still "up", A4H). Direction-mirrored rather
// than one fixed condition for both, and shared between the tick below and
// the ranking's own 4H axis so the two always agree on what counts.
function matchesFourHourTick(s: StoredWtSignal): boolean {
  return s.direction === "long" ? s.fourHourTrend === "down" : s.fourHourTrend === "up";
}

// Sky-blue tick, distinct from the amber/violet ticks above — informational,
// not a gate: it doesn't touch WT qualification and has nothing to do with
// the "SMA crossing Supertrend" strategy this tab otherwise excludes
// entirely.
function fourHourTick(s: StoredWtSignal) {
  if (!matchesFourHourTick(s)) return null;
  const label = s.direction === "long" ? "B4H" : "A4H";
  const title = s.direction === "long" ? "Below the 4H Supertrend line" : "Above the 4H Supertrend line";
  return (
    <span className="text-[9px] font-semibold uppercase text-sky-400" title={title}>
      {label}
    </span>
  );
}

// Bid/ask spread as a percentage of the premium itself — a tight spread
// (small %) means the quoted mid is trustworthy and the contract is liquid
// enough to actually trade near it; a wide one means the mid is a rougher
// estimate. Thresholds are a rule of thumb for NSE F&O options, not derived
// from anything in this codebase.
function bidAskColorClass(percent: number): string {
  if (percent <= 3) return "text-accent";
  if (percent <= 7) return "text-amber-400";
  return "text-danger";
}

// Redis holds whatever the last run(s) wrote per-batch, and this signal's
// own shape has changed more than once today (isDouble/signalDate ->
// wtBreachDate/hasDoubleWt/dwtDate/nextGap) — if the daily cron's three
// batches straddled a deploy, "wtsignals:latest" can end up merging
// old-shaped and new-shaped objects together, since each batch key is only
// ever validated by whatever code wrote it. TypeScript's cast in
// getLatestWtSignals doesn't check this at runtime, so this page checks it
// explicitly and drops anything that doesn't match, rather than crashing
// the whole route on one stale entry the way the main Strategy tab once did.
function isCurrentShape(s: unknown): s is StoredWtSignal {
  if (typeof s !== "object" || s === null) return false;
  const r = s as Record<string, unknown>;
  return (
    typeof r.symbol === "string" &&
    (r.direction === "long" || r.direction === "short") &&
    typeof r.wtBreachDate === "string" &&
    typeof r.wt2AtSignal === "number" &&
    typeof r.wtDays === "number" &&
    typeof r.hasDoubleWt === "boolean" &&
    typeof r.entryPrice === "number" &&
    typeof r.volumeSpike === "object" &&
    r.volumeSpike !== null
  );
}

// Percentile rank of each value within the given set (0-100) — same
// approach as lib/scanFilter.ts's own ranking, just duplicated here rather
// than imported since this is a small, self-contained display-ordering
// concern, not a signal-detection one.
function percentileRanks(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((v) => {
    let countAtOrBelow = 0;
    for (const s of sorted) if (s <= v) countAtOrBelow++;
    return (countAtOrBelow / sorted.length) * 100;
  });
}

// Relative weight of each ranking factor. WT depth, option cheapness, and
// gap size stay equal-weighted per the last request; wtDays (see
// lib/wtStrategy.ts — how many daily candles the excursion has run) now
// carries its own substantial weight rather than being folded into WT
// depth, since a stock can be freshly breached but very deep, or shallow
// but breached for weeks — two different things. The 4H Supertrend read
// stays the smallest, tiebreaker-ish factor.
const WT_RANK_WEIGHT = 0.25;
const PREMIUM_RANK_WEIGHT = 0.25;
const GAP_RANK_WEIGHT = 0.25;
const WT_DAYS_RANK_WEIGHT = 0.15;
const FOUR_HOUR_RANK_WEIGHT = 0.1;

/**
 * Orders one direction's signals by a blend of five factors: how deep
 * today's WT breach is (|wt2AtSignal| — further past +-55 ranks higher,
 * 25% weight), how CHEAP the ATM/ITM option is relative to its own strike
 * (premiumPercentOfStrike — lower ranks higher, since the axis is inverted
 * below, 25% weight), how large the same-direction gap target is
 * (|nextGap.percent|, 25% weight), how many daily candles the excursion
 * has run (wtDays — more days ranks higher, a stock that's stayed past
 * +-55 longer is weighted more, 15% weight), and whether
 * matchesFourHourTick holds — the B4H/A4H tick above — worth a flat 100/0
 * rather than a percentile rank since it's a yes/no read, not a magnitude
 * (10% weight). A stock missing nextGap or atmOption (no gap nearby, or
 * the option chain lookup failed) ranks at the BOTTOM of that one axis
 * rather than being excluded — same treatment throughout, so missing data
 * never accidentally helps a stock's ranking.
 */
function rankSignals(signals: StoredWtSignal[]): StoredWtSignal[] {
  if (signals.length <= 1) return signals;
  const wtStrength = signals.map((s) => Math.abs(s.wt2AtSignal));
  const gapStrength = signals.map((s) => (s.nextGap ? Math.abs(s.nextGap.percent) : 0));
  // Percentile-ranking premium% directly would put the MOST expensive
  // option at the top; inverting (100 - rank) makes the cheapest one rank
  // highest instead. A missing atmOption gets +Infinity going in, which
  // sorts to the most-expensive end and so inverts to ~0 — the bottom of
  // this axis, never a boost.
  const premiumCost = signals.map((s) => s.atmOption?.premiumPercentOfStrike ?? Infinity);
  const wtRanks = percentileRanks(wtStrength);
  const gapRanks = percentileRanks(gapStrength);
  const premiumRanks = percentileRanks(premiumCost).map((r) => 100 - r);
  const wtDaysRanks = percentileRanks(signals.map((s) => s.wtDays));
  const fourHourScores = signals.map((s) => (matchesFourHourTick(s) ? 100 : 0));
  return signals
    .map((s, i) => ({
      s,
      score:
        WT_RANK_WEIGHT * wtRanks[i] +
        PREMIUM_RANK_WEIGHT * premiumRanks[i] +
        GAP_RANK_WEIGHT * gapRanks[i] +
        WT_DAYS_RANK_WEIGHT * wtDaysRanks[i] +
        FOUR_HOUR_RANK_WEIGHT * fourHourScores[i],
    }))
    .sort((a, b) => b.score - a.score)
    .map((r) => r.s);
}

export default async function Strategy2Page() {
  if (!isConnected()) redirect("/settings");

  let latest: Awaited<ReturnType<typeof getLatestWtSignals>> = null;
  let error: string | null = null;
  try {
    latest = await getLatestWtSignals();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load signals.";
  }

  const validSignals = (latest?.signals ?? []).filter(isCurrentShape);
  const longSignals = rankSignals(validSignals.filter((s) => s.direction === "long"));
  const shortSignals = rankSignals(validSignals.filter((s) => s.direction === "short"));

  return (
    <main className="px-4 pt-6">
      <h1 className="text-xl font-semibold">Strategy Tab 2</h1>
      <p className="mt-1 text-sm text-muted">
        WT breach is the only filter — Double WT, volume spike, and a same-direction 4H Supertrend read (B4H on
        longs, A4H on shorts) are shown as ticks on top, and the Supertrend + SMA crossover strategy plays no part
        here.
      </p>

      <div className="mt-4">
        <RunWtStrategyButton />
      </div>

      {error && (
        <p className="mt-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</p>
      )}

      {!error && (!latest || validSignals.length === 0) && (
        <div className="mt-6 rounded-xl border border-border bg-surface p-5 text-center">
          <p className="text-3xl">🤖</p>
          <p className="mt-3 text-sm text-muted">
            {latest
              ? `No signals from the last run (${new Date(latest.runAt).toLocaleString("en-IN", {
                  timeZone: "Asia/Kolkata",
                  day: "numeric",
                  month: "short",
                  hour: "numeric",
                  minute: "2-digit",
                })} IST).`
              : "No signals yet — run the strategy above, or wait for the daily routine after market close."}
          </p>
        </div>
      )}

      {!error && latest && validSignals.length > 0 && (
        <>
          <p className="mt-4 text-xs text-muted">
            Last run{" "}
            {new Date(latest.runAt).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
              day: "numeric",
              month: "short",
              hour: "numeric",
              minute: "2-digit",
            })}{" "}
            IST
          </p>

          <div className="mt-4 grid grid-cols-2 gap-3">
            {([
              { label: "Long", rows: longSignals },
              { label: "Short", rows: shortSignals },
            ] as const).map(({ label, rows }) => (
              <div key={label}>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
                  {label} ({rows.length})
                </h2>
                <ul className="mt-2 space-y-2">
                  {rows.length === 0 && <li className="text-xs text-muted">No signals</li>}
                  {rows.map((s, i) => (
                    <li key={`${s.symbol}-${i}`} className="rounded-lg border border-border bg-surface p-2.5">
                      <div className="flex items-center justify-between gap-1">
                        <p className="truncate text-xs font-medium">{s.symbol}</p>
                        <span className="flex shrink-0 gap-1">
                          {volumeTick(s)}
                          {doubleWtTick(s)}
                          {fourHourTick(s)}
                        </span>
                      </div>
                      <p className={`text-[10px] font-semibold uppercase ${s.direction === "short" ? "text-danger" : "text-accent"}`}>
                        {s.direction === "short" ? "Short" : "Long"}
                      </p>
                      <p className="mt-1 text-[11px] text-muted">
                        LTP {fmt(s.entryPrice)}
                        <br />
                        WT {s.wt2AtSignal.toFixed(0)}{" "}
                        <span title={`${s.wtDays} daily candle${s.wtDays === 1 ? "" : "s"} spent past +-55, including today`}>
                          🔥{s.wtDays}
                        </span>
                        {s.hasDoubleWt && (
                          <>
                            <br />
                            DWT {dateOnly(s.dwtDate ?? "")}
                          </>
                        )}
                        {s.nextGap && (
                          <>
                            <br />
                            Gap {fmt(s.nextGap.price)} ({s.nextGap.percent >= 0 ? "+" : ""}
                            {s.nextGap.percent.toFixed(1)}%)
                          </>
                        )}
                      </p>
                      {s.atmOption && (
                        <p className="mt-1 text-[11px] text-muted">
                          {s.atmOption.optionType} {fmt(s.atmOption.strike)} · {dateOnly(s.atmOption.expiry)}
                          <br />
                          Premium {fmt(s.atmOption.premium)} ({s.atmOption.premiumPercentOfStrike.toFixed(2)}% of strike)
                          {" · "}
                          {s.atmOption.bidAskSpreadPercent !== null ? (
                            <span className={`font-semibold ${bidAskColorClass(s.atmOption.bidAskSpreadPercent)}`}>
                              spread {s.atmOption.bidAskSpreadPercent.toFixed(1)}%
                            </span>
                          ) : (
                            <span className="italic">no live bid/ask</span>
                          )}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
