import { redirect } from "next/navigation";
import { isConnected } from "@/lib/session";
import { getPaperTrades, getCapitalBase } from "@/lib/kv";
import { computePerformance } from "@/lib/performance";
import CapitalBaseEditor from "@/components/CapitalBaseEditor";
import ReturnCagrToggle from "@/components/ReturnCagrToggle";

export const dynamic = "force-dynamic";

function fmt(n: number, digits = 0) {
  return n.toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
function signedFmt(n: number, digits = 0) {
  return `${n >= 0 ? "+" : ""}${fmt(n, digits)}`;
}
function monthLabel(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
}

export default async function PerformancePage() {
  if (!isConnected()) redirect("/settings");

  let error: string | null = null;
  let summary: ReturnType<typeof computePerformance> | null = null;
  try {
    const [trades, capitalBase] = await Promise.all([getPaperTrades(), getCapitalBase()]);
    summary = computePerformance(trades, capitalBase);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load performance data.";
  }

  const maxAbsMonthlyPnl = summary ? Math.max(1, ...summary.monthly.map((m) => Math.abs(m.totalPnl))) : 1;

  return (
    <main className="px-4 pt-6 pb-4">
      <h1 className="text-xl font-semibold">Performance</h1>
      <p className="mt-1 text-sm text-muted">
        Realized returns from closed paper trades, on the peak capital actually deployed at any one time — nothing
        here counts a position until it's actually closed.
      </p>

      {error && (
        <p className="mt-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</p>
      )}

      {!error && summary && (
        <div className="mt-4 rounded-xl border border-border bg-surface p-4">
          <p className="text-xs text-muted">Portfolio value</p>
          <p className="mt-1 text-2xl font-semibold">₹{fmt(summary.currentPortfolioValue)}</p>
          <p className="mt-1 text-[11px] text-muted">
            ₹{fmt(summary.capitalBase)} base {summary.overall.totalPnl >= 0 ? "+" : ""}
            ₹{signedFmt(summary.overall.totalPnl)} realized
            {summary.openPositionsUnrealizedPnl !== 0 &&
              ` ${summary.openPositionsUnrealizedPnl >= 0 ? "+" : ""}₹${signedFmt(summary.openPositionsUnrealizedPnl)} unrealized`}
          </p>
          <div className="mt-2">
            <CapitalBaseEditor capitalBase={summary.capitalBase} />
          </div>
        </div>
      )}

      {!error && summary && summary.overall.tradeCount === 0 && (
        <div className="mt-6 rounded-xl border border-border bg-surface p-5 text-center">
          <p className="text-3xl">📈</p>
          <p className="mt-3 text-sm text-muted">No closed paper trades yet — this fills in once you close a position.</p>
        </div>
      )}

      {!error && summary && summary.overall.tradeCount > 0 && (
        <>
          <div className="mt-4 rounded-xl border border-border bg-surface p-4">
            <p className="text-xs text-muted">Overall return on max capital deployed</p>
            <ReturnCagrToggle
              returnPercent={summary.overall.returnPercent}
              cagrPercent={summary.overall.cagrPercent}
              tradingDayCount={summary.overall.tradingDayCount}
              daysSinceStart={summary.overall.daysSinceStart}
              totalPnl={summary.overall.totalPnl}
            />
            <div className="mt-3 grid grid-cols-2 gap-y-1.5 text-sm">
              <span className="text-muted">Realized P&amp;L</span>
              <span className={`text-right font-medium ${summary.overall.totalPnl >= 0 ? "text-accent" : "text-danger"}`}>
                ₹{signedFmt(summary.overall.totalPnl)}
              </span>
              <span className="text-muted">Max capital deployed</span>
              <span className="text-right font-medium">₹{fmt(summary.overall.maxCapitalDeployed)}</span>
              <span className="text-muted">Return on ₹{fmt(summary.capitalBase)} base</span>
              <span className={`text-right font-medium ${summary.overall.returnOnBasePercent >= 0 ? "text-accent" : "text-danger"}`}>
                {signedFmt(summary.overall.returnOnBasePercent, 2)}%
              </span>
              <span className="text-muted">Closed trades</span>
              <span className="text-right font-medium">
                {summary.overall.tradeCount} ({summary.overall.wins}W / {summary.overall.losses}L)
              </span>
            </div>
            <p className="mt-2 text-[10px] text-muted">
              &ldquo;Max capital deployed&rdquo; is the peak total capital the whole book ever had in use at one time
              (not a sum across trades) — a position that never overlapped another counts on its own, not stacked
              with the rest.
            </p>
            {summary.openPositionsUnrealizedPnl !== 0 && (
              <p className="mt-2 text-[10px] text-muted">
                Open positions currently mark {summary.openPositionsUnrealizedPnl >= 0 ? "+" : ""}
                ₹{fmt(summary.openPositionsUnrealizedPnl)} unrealized — not counted above until closed.
              </p>
            )}
          </div>

          <h2 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Portfolio value (₹{fmt(summary.capitalBase)} base)</h2>
          <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {summary.portfolioValue.map((p) => (
              <li key={p.month} className="bg-surface px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{monthLabel(p.month)}</span>
                  <span className="text-sm font-semibold">₹{fmt(p.value)}</span>
                </div>
              </li>
            ))}
          </ul>

          <h2 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Monthly P&amp;L</h2>
          <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {summary.monthly.map((m) => {
              const widthPct = Math.max(2, (Math.abs(m.totalPnl) / maxAbsMonthlyPnl) * 100);
              return (
                <li key={m.month} className="relative bg-surface px-4 py-3">
                  <div
                    className={`absolute inset-y-0 left-0 ${m.totalPnl >= 0 ? "bg-accent/10" : "bg-danger/10"}`}
                    style={{ width: `${widthPct}%` }}
                  />
                  <div className="relative flex items-center justify-between">
                    <span className="font-medium">{monthLabel(m.month)}</span>
                    <span className={`text-sm font-semibold ${m.totalPnl >= 0 ? "text-accent" : "text-danger"}`}>
                      ₹{signedFmt(m.totalPnl)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>

          <h2 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Monthly returns</h2>
          <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {summary.monthly.map((m) => (
              <li key={m.month} className="bg-surface px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{monthLabel(m.month)}</span>
                  <span className={`text-sm font-semibold ${m.totalPnl >= 0 ? "text-accent" : "text-danger"}`}>
                    {m.returnPercent !== null ? `${signedFmt(m.returnPercent, 1)}%` : "—"}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-muted">
                  ₹{signedFmt(m.totalPnl)} on ₹{fmt(m.maxCapitalDeployed)} max capital ({signedFmt(m.returnOnBasePercent, 2)}% of
                  base) · {m.tradeCount} trade{m.tradeCount === 1 ? "" : "s"} ({m.wins}W / {m.losses}L) ·{" "}
                  {m.tradingDayCount} day{m.tradingDayCount === 1 ? "" : "s"} traded
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
