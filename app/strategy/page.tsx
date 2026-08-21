import { redirect } from "next/navigation";
import { isConnected } from "@/lib/session";
import { getLatestSignals } from "@/lib/kv";
import RunStrategyButton from "@/components/RunStrategyButton";

export const dynamic = "force-dynamic";

function fmt(n: number) {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
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
      <h1 className="text-xl font-semibold">Strategy</h1>
      <p className="mt-1 text-sm text-muted">
        Supertrend(14,1) + SMA20/50/100/200 crossover — Daily for stocks, Daily &amp; 4H for indices
      </p>

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
          <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {latest.signals.map((s, i) => (
              <li key={`${s.symbol}-${s.timeframe}-${i}`} className="bg-surface px-4 py-3.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    {s.symbol} <span className="text-[10px] font-normal text-muted">{s.timeframe}</span>
                  </span>
                  <span
                    className={`text-xs font-semibold uppercase ${
                      s.direction === "short" ? "text-danger" : "text-accent"
                    }`}
                  >
                    {s.direction}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-muted">
                  {s.signalDate} · Entry {fmt(s.entryPrice)} · ST {fmt(s.supertrendValue)} · SMA{s.triggerSma.period}{" "}
                  crossed the line · Target SMA{s.targetSma.period} ({fmt(s.targetSma.value)})
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
