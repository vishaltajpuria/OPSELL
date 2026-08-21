"use client";

import { useMemo, useState } from "react";

type Trade = {
  symbol: string;
  direction: "short" | "long";
  label: string;
  signalDate: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string | null;
  exitPrice: number | null;
  exitReason: "target" | "invalidated" | "open" | "no_next_candle";
  pnlPercent: number | null;
  holdDays: number | null;
};

type BacktestResponse = {
  from: string;
  to: string;
  symbolCount: number;
  trades: Trade[];
  errors: string[];
};

function fmt(n: number, digits = 2) {
  return n.toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function csvEscape(value: unknown): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(result: BacktestResponse, overall: ReturnType<typeof summarize>): string {
  const lines: string[] = [
    "OPSELL Backtest",
    `Range,${result.from} to ${result.to}`,
    `Symbols,${result.symbolCount}`,
    `Total trades,${overall.total}`,
    `Resolved,${overall.resolved}`,
    `Wins,${overall.wins}`,
    `Losses,${overall.losses}`,
    `Open,${overall.open}`,
    `Win rate %,${overall.winRate.toFixed(2)}`,
    `Avg P&L % per trade,${overall.avgPnl.toFixed(2)}`,
    `Total P&L % (summed),${overall.totalPnl.toFixed(2)}`,
    "",
    ["Symbol", "Direction", "Label", "SignalDate", "EntryDate", "EntryPrice", "ExitDate", "ExitPrice", "ExitReason", "PnLPercent", "HoldDays"].join(","),
  ];
  for (const t of result.trades) {
    lines.push(
      [
        t.symbol,
        t.direction,
        t.label,
        t.signalDate,
        t.entryDate,
        t.entryPrice,
        t.exitDate ?? "",
        t.exitPrice ?? "",
        t.exitReason,
        t.pnlPercent === null ? "" : t.pnlPercent.toFixed(2),
        t.holdDays === null ? "" : t.holdDays,
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  return lines.join("\n");
}

function downloadCsv(result: BacktestResponse, overall: ReturnType<typeof summarize>) {
  const csv = toCsv(result, overall);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `opsell-backtest-${result.from}-to-${result.to}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function summarize(trades: Trade[]) {
  const resolved = trades.filter((t) => t.pnlPercent !== null);
  const wins = resolved.filter((t) => (t.pnlPercent as number) > 0);
  const losses = resolved.filter((t) => (t.pnlPercent as number) <= 0);
  const open = trades.length - resolved.length;
  const totalPnl = resolved.reduce((s, t) => s + (t.pnlPercent as number), 0);
  return {
    total: trades.length,
    resolved: resolved.length,
    wins: wins.length,
    losses: losses.length,
    open,
    winRate: resolved.length ? (wins.length / resolved.length) * 100 : 0,
    avgPnl: resolved.length ? totalPnl / resolved.length : 0,
    totalPnl,
  };
}

export default function BacktestRunner() {
  const [symbolsText, setSymbolsText] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResponse | null>(null);

  const overall = useMemo(() => (result ? summarize(result.trades) : null), [result]);
  const perStock = useMemo(() => {
    if (!result) return [];
    const bySymbol = new Map<string, Trade[]>();
    for (const t of result.trades) {
      const arr = bySymbol.get(t.symbol) ?? [];
      arr.push(t);
      bySymbol.set(t.symbol, arr);
    }
    return Array.from(bySymbol.entries())
      .map(([symbol, trades]) => ({ symbol, ...summarize(trades) }))
      .sort((a, b) => b.totalPnl - a.totalPnl);
  }, [result]);

  const MAX_SYMBOLS = 150; // ~50s at Kite's 3 req/sec — keeps a single run under Vercel's 60s cap

  async function run() {
    const symbols = symbolsText
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (symbols.length === 0) {
      setError("Paste at least one symbol first.");
      setStatus("error");
      return;
    }
    if (symbols.length > MAX_SYMBOLS) {
      setError(`That's ${symbols.length} symbols — please run ${MAX_SYMBOLS} or fewer at a time (split into two runs), or the whole thing risks timing out.`);
      setStatus("error");
      return;
    }
    setStatus("running");
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/strategy/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Backtest failed.");
      }
      setResult(data);
      setStatus("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  return (
    <div>
      <p className="mt-1 text-xs text-muted">
        Paste NSE symbols (comma or newline separated) — e.g. the top 30 F&amp;O stocks by market cap. ~2 years
        of daily data per symbol, walk-forward simulated against the same Supertrend + SMA logic as the Strategy
        tab. Assumptions: entry at next day&apos;s open after a signal; exit the first day price touches the
        (moving) target SMA, or the first day Supertrend flips against the trade if the target isn&apos;t hit
        first; trades still unresolved after ~90 trading days are marked &quot;open&quot;, not counted as a
        win or loss.
      </p>

      <textarea
        value={symbolsText}
        onChange={(e) => setSymbolsText(e.target.value)}
        placeholder={"RELIANCE\nHDFCBANK\nTCS\n..."}
        rows={5}
        className="mt-3 w-full rounded-lg border border-border bg-surface2 p-3 text-sm"
      />

      <button
        onClick={run}
        disabled={status === "running"}
        className="mt-3 w-full rounded-xl bg-accent px-4 py-3 text-center text-sm font-medium text-black disabled:opacity-60"
      >
        {status === "running" ? "Running… this can take a minute" : "Run backtest"}
      </button>

      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      {result && overall && (
        <div className="mt-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted">
              {result.symbolCount} symbol{result.symbolCount === 1 ? "" : "s"} · {result.from} to {result.to}
              {result.errors.length > 0 && ` · ${result.errors.length} error(s)`}
            </p>
            <button
              onClick={() => downloadCsv(result, overall)}
              className="shrink-0 rounded-lg border border-border bg-surface2 px-3 py-1.5 text-xs font-medium"
            >
              Download CSV
            </button>
          </div>

          <div className="mt-3 rounded-xl border border-border bg-surface p-4">
            <div className="grid grid-cols-2 gap-y-2 text-sm">
              <span className="text-muted">Total trades</span>
              <span className="text-right font-medium">{overall.total}</span>
              <span className="text-muted">Resolved (win/loss)</span>
              <span className="text-right font-medium">{overall.resolved}</span>
              <span className="text-muted">Win rate</span>
              <span className="text-right font-medium">{fmt(overall.winRate, 1)}%</span>
              <span className="text-muted">Wins / Losses</span>
              <span className="text-right font-medium">
                {overall.wins} / {overall.losses}
              </span>
              <span className="text-muted">Still open</span>
              <span className="text-right font-medium">{overall.open}</span>
              <span className="text-muted">Avg P&amp;L / trade</span>
              <span className={`text-right font-medium ${overall.avgPnl >= 0 ? "text-accent" : "text-danger"}`}>
                {overall.avgPnl >= 0 ? "+" : ""}
                {fmt(overall.avgPnl)}%
              </span>
              <span className="text-muted">Total P&amp;L (summed)</span>
              <span className={`text-right font-medium ${overall.totalPnl >= 0 ? "text-accent" : "text-danger"}`}>
                {overall.totalPnl >= 0 ? "+" : ""}
                {fmt(overall.totalPnl)}%
              </span>
            </div>
          </div>

          {result.errors.length > 0 && (
            <details className="mt-2 text-xs text-muted">
              <summary>Errors</summary>
              <ul className="mt-1 list-disc pl-4">
                {result.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </details>
          )}

          <h2 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Per stock</h2>
          <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {perStock.map((s) => (
              <li key={s.symbol} className="bg-surface px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{s.symbol}</span>
                  <span className={`text-sm font-semibold ${s.totalPnl >= 0 ? "text-accent" : "text-danger"}`}>
                    {s.totalPnl >= 0 ? "+" : ""}
                    {fmt(s.totalPnl)}%
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-muted">
                  {s.resolved} resolved ({s.wins}W / {s.losses}L, {fmt(s.winRate, 0)}% win rate)
                  {s.open > 0 && ` · ${s.open} open`}
                </div>
              </li>
            ))}
          </ul>

          <h2 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">All trades</h2>
          <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {result.trades.map((t, i) => (
              <li key={i} className="bg-surface px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    {t.symbol} <span className="text-[10px] font-normal text-muted">{t.label}</span>
                  </span>
                  <span
                    className={`text-sm font-semibold ${
                      t.pnlPercent === null ? "text-muted" : t.pnlPercent >= 0 ? "text-accent" : "text-danger"
                    }`}
                  >
                    {t.pnlPercent === null ? "open" : `${t.pnlPercent >= 0 ? "+" : ""}${fmt(t.pnlPercent)}%`}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-muted">
                  Entry {t.entryDate} @ {fmt(t.entryPrice)}
                  {t.exitDate && ` · Exit ${t.exitDate} @ ${fmt(t.exitPrice as number)} (${t.exitReason})`}
                  {t.holdDays !== null && ` · ${t.holdDays}d`}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
