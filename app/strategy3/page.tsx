import { redirect } from "next/navigation";
import { isConnected } from "@/lib/session";
import { getLatestStrategy3Signals, type StoredStrategy3Signal } from "@/lib/kv";
import RunStrategy3Button from "@/components/RunStrategy3Button";

export const dynamic = "force-dynamic";

function fmt(n: number) {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

// Redis holds whatever the last run(s) wrote per-batch — same defensive
// shape check as app/strategy2/page.tsx's own isCurrentShape, for the same
// reason (a deploy landing mid-cron could otherwise merge old- and
// new-shaped objects into "strategy3:latest"). Only the fields that are
// always set synchronously by detectStrategy3Signal are required here;
// gapUp/gapDown/atmOption/volumeAccumulation are all nullable/optional by
// design already, so a missing one just means "not available," not a
// shape mismatch.
function isCurrentShape(s: unknown): s is StoredStrategy3Signal {
  if (typeof s !== "object" || s === null) return false;
  const r = s as Record<string, unknown>;
  return typeof r.symbol === "string" && (r.direction === "long" || r.direction === "short") && typeof r.entryPrice === "number";
}

// Whale emoji tick — "whales accumulating" per the request — shown when
// the stock's own near-month FUTURES contract (not cash volume; see
// lib/futuresVolume.ts) has seen its recent few-day average volume at
// least double its trailing 3-month average. Purely informational, same
// as every other tick in this app: it doesn't gate which stocks make this
// tab's list, only decorates one that already qualified on the
// triple-timeframe Supertrend gate.
function volumeAccumulationTick(s: StoredStrategy3Signal) {
  if (!s.volumeAccumulation || s.volumeAccumulation.status !== "confirmed") return null;
  return (
    <span
      className="text-[9px] font-semibold uppercase text-cyan-400"
      title={`Futures volume ${s.volumeAccumulation.ratio.toFixed(1)}x the 3-month daily average over the last few days`}
    >
      🐋 {s.volumeAccumulation.ratio.toFixed(1)}x
    </span>
  );
}

function bidAskColorClass(percent: number): string {
  if (percent <= 3) return "text-accent";
  if (percent <= 7) return "text-amber-400";
  return "text-danger";
}

// Headline metric first: a confirmed, stronger volume-accumulation read
// ranks higher within its own Long/Short list. Unconfirmed or unresolved
// (no futures data yet) sits at the bottom, same "missing data never
// helps" treatment used throughout app/strategy2/page.tsx's own ranking —
// not a weighted blend, just this one ordering, since no ranking scheme
// was requested for this tab.
function sortByVolumeAccumulation(signals: StoredStrategy3Signal[]): StoredStrategy3Signal[] {
  return [...signals].sort((a, b) => (b.volumeAccumulation?.ratio ?? 0) - (a.volumeAccumulation?.ratio ?? 0));
}

export default async function Strategy3Page() {
  if (!isConnected()) redirect("/settings");

  let latest: Awaited<ReturnType<typeof getLatestStrategy3Signals>> = null;
  let error: string | null = null;
  try {
    latest = await getLatestStrategy3Signals();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load signals.";
  }

  const validSignals = (latest?.signals ?? []).filter(isCurrentShape);
  const longSignals = sortByVolumeAccumulation(validSignals.filter((s) => s.direction === "long"));
  const shortSignals = sortByVolumeAccumulation(validSignals.filter((s) => s.direction === "short"));

  return (
    <main className="px-4 pt-6">
      <h1 className="text-xl font-semibold">Strategy Tab 3</h1>
      <p className="mt-1 text-sm text-muted">
        Tracks every F&amp;O stock whose Supertrend trend agrees on the weekly, daily, AND 4H chart at once — below
        all three for longs, above all three for shorts — regardless of WaveTrend. Both the nearest gap up and gap
        down are shown either way, and 🐋 flags a stock whose own futures contract has seen a recent few-day volume
        buildup at least double its 3-month average. The Supertrend + SMA crossover strategy and Strategy Tab 2's WT
        gate play no part here.
      </p>

      <div className="mt-4">
        <RunStrategy3Button />
      </div>

      {error && (
        <p className="mt-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</p>
      )}

      {!error && (!latest || validSignals.length === 0) && (
        <div className="mt-6 rounded-xl border border-border bg-surface p-5 text-center">
          <p className="text-3xl">🔭</p>
          <p className="mt-3 text-sm text-muted">
            {latest
              ? `No stocks tracked from the last run (${new Date(latest.runAt).toLocaleString("en-IN", {
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
                        <span className="flex shrink-0 gap-1">{volumeAccumulationTick(s)}</span>
                      </div>
                      <p className={`text-[10px] font-semibold uppercase ${s.direction === "short" ? "text-danger" : "text-accent"}`}>
                        {s.direction === "short" ? "Short" : "Long"}
                      </p>
                      <p className="mt-1 text-[11px] text-muted">
                        LTP {fmt(s.entryPrice)}
                        {s.gapUp && (
                          <>
                            <br />
                            Gap ↑ {fmt(s.gapUp.price)} (+{s.gapUp.percent.toFixed(1)}%)
                          </>
                        )}
                        {s.gapDown && (
                          <>
                            <br />
                            Gap ↓ {fmt(s.gapDown.price)} ({s.gapDown.percent.toFixed(1)}%)
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
