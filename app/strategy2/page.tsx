import { redirect } from "next/navigation";
import { isConnected } from "@/lib/session";
import { getLatestWtSignals, type StoredWtSignal } from "@/lib/kv";
import RunWtStrategyButton from "@/components/RunWtStrategyButton";

export const dynamic = "force-dynamic";

function fmt(n: number) {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

// "Super" mirrors the main Strategy tab's SMA50/100-vs-SMA20 naming: the
// stronger, rarer version of the same underlying condition (Double WT vs a
// single WT breach — see lib/wtStrategy.ts).
function signalLabel(s: StoredWtSignal): string {
  const base = s.direction === "short" ? "Short" : "Long";
  return s.isDouble ? `Super ${base}` : base;
}

// Amber badge, same meaning and color as the main Strategy tab's — a
// same-direction volume spike within its own recent history (see
// lib/volumeSpike.ts). Purely factual, not a verdict on strength: your own
// backtest of the main strategy showed a volume spike does NOT reliably
// make a signal stronger, so this is shown for you to judge, not to imply
// "confirmed = better."
function volumeBadge(s: StoredWtSignal) {
  if (s.volumeSpike.status !== "confirmed") return null;
  return (
    <span
      className="text-[9px] font-semibold uppercase text-amber-400"
      title={`Volume spike ${s.volumeSpike.spikeRatio?.toFixed(1)}x the 30-day average on ${s.volumeSpike.spikeDate}`}
    >
      Vol ✓
    </span>
  );
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

  const longSignals = (latest?.signals ?? []).filter((s) => s.direction === "long").sort((a, b) => (b.isDouble ? 1 : 0) - (a.isDouble ? 1 : 0));
  const shortSignals = (latest?.signals ?? []).filter((s) => s.direction === "short").sort((a, b) => (b.isDouble ? 1 : 0) - (a.isDouble ? 1 : 0));

  return (
    <main className="px-4 pt-6">
      <h1 className="text-xl font-semibold">Strategy Tab 2</h1>
      <p className="mt-1 text-sm text-muted">
        WT / Double WT first, volume spike checked on top — the Supertrend + SMA crossover strategy plays no part
        here.
      </p>

      <div className="mt-4">
        <RunWtStrategyButton />
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
              : "No signals yet — run the strategy above, or wait for the daily routine after market close."}
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
                        {volumeBadge(s)}
                      </div>
                      <p className={`text-[10px] font-semibold uppercase ${s.direction === "short" ? "text-danger" : "text-accent"}`}>
                        {signalLabel(s)}
                      </p>
                      <p className="mt-1 text-[11px] text-muted">
                        Entry {fmt(s.entryPrice)}
                        <br />
                        {s.isDouble ? "2nd breach" : "Breach"} {s.signalDate} · wt2 {s.wt2AtSignal.toFixed(0)}
                      </p>
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
