import { redirect } from "next/navigation";
import { isConnected } from "@/lib/session";
import { getLatestSignals, type StoredSignal } from "@/lib/kv";
import RunStrategyButton from "@/components/RunStrategyButton";

export const dynamic = "force-dynamic";

function fmt(n: number) {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

// SMA20 crossing is the "regular" signal; SMA50/SMA100 crossing (the faster
// average having already caught up to a slower one) is the stronger "super"
// version of the same call.
function signalLabel(s: StoredSignal): string {
  const base = s.direction === "short" ? "Short" : "Long";
  const isSuper = s.triggerSma.period === 50 || s.triggerSma.period === 100;
  return isSuper ? `Super ${base}` : base;
}

// % distance from entry to the target SMA — the maximum move the setup is
// pointing at. Signals are sorted by this, largest first, rather than
// hard-filtered by direction or label: backtesting the "Super" label
// against 3 years of real trades showed Super Short/Long actually
// underperform regular Short/Long (lower win rate AND lower avg P&L — a
// "Super" signal fires later, once the move has already run further, not on
// a stronger setup), so that's not used as a filter. A hard cutoff on this
// gap % would also arbitrarily hide otherwise-fine setups on a quiet day;
// sorting keeps everything visible while surfacing the most promising ones
// first.
function targetGapPercent(s: StoredSignal): number {
  return (Math.abs(s.targetSma.value - s.entryPrice) / s.entryPrice) * 100;
}

// Amber border/badge marks a signal whose crossover was backed by a real
// volume spike (own 30-day history, not just today vs. other stocks — see
// lib/volumeSpike.ts) within 10 trading days of firing. Amber rather than
// accent/danger green-red so it reads as a separate axis from direction,
// not a third color competing with long/short.
//
// s.volumeSpike can be missing on a signal that's still the stale output of
// a daily-cron run from before this field existed — Redis just holds
// whatever the last run wrote, so a currently-deployed build can render
// data shaped by an older one until the next run overwrites it. Treated as
// "no spike" rather than crashing the page.
function volumeSpikeBorderClass(s: StoredSignal): string {
  return s.volumeSpike?.status === "confirmed" ? "border-amber-400/70" : "border-border";
}

export default async function StrategyPage() {
  if (!isConnected()) redirect("/settings");

  let latest: Awaited<ReturnType<typeof getLatestSignals>> = null;
  let error: string | null = null;
  try {
    latest = await getLatestSignals();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load signals.";
  }

  return (
    <main className="px-4 pt-6">
      <h1 className="text-xl font-semibold">Strategy Supertrend</h1>

      <div className="mt-4">
        <RunStrategyButton />
      </div>

      {error && (
        <p className="mt-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</p>
      )}

      {!error && (!latest || latest.signals.length === 0) && (
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
              : "No signals yet — the daily routine runs after market close on trading days."}
          </p>
        </div>
      )}

      {!error && latest && latest.signals.length > 0 && (
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
            {(["1D", "4H"] as const).map((timeframe) => {
              const rows = latest.signals
                .filter((s) => s.timeframe === timeframe)
                .sort((a, b) => targetGapPercent(b) - targetGapPercent(a));
              return (
                <div key={timeframe}>
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
                    {timeframe === "1D" ? "Daily" : "4H"} ({rows.length})
                  </h2>
                  <ul className="mt-2 space-y-2">
                    {rows.length === 0 && <li className="text-xs text-muted">No signals</li>}
                    {rows.map((s, i) => (
                      <li
                        key={`${s.symbol}-${s.timeframe}-${i}`}
                        className={`rounded-lg border bg-surface p-2.5 ${volumeSpikeBorderClass(s)}`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <p className="truncate text-xs font-medium">{s.symbol}</p>
                          {s.volumeSpike?.status === "confirmed" && (
                            <span
                              className="shrink-0 text-[9px] font-semibold uppercase text-amber-400"
                              title={`Volume spike ${s.volumeSpike.spikeRatio?.toFixed(1)}x the 30-day average on ${s.volumeSpike.spikeDate}`}
                            >
                              Vol ✓
                            </span>
                          )}
                        </div>
                        <p
                          className={`text-[10px] font-semibold uppercase ${
                            s.direction === "short" ? "text-danger" : "text-accent"
                          }`}
                        >
                          {signalLabel(s)}
                        </p>
                        <p className="mt-1 text-[11px] text-muted">
                          Entry {fmt(s.entryPrice)}
                          <br />
                          Target {fmt(s.targetSma.value)} ({targetGapPercent(s).toFixed(1)}%)
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </>
      )}
    </main>
  );
}
