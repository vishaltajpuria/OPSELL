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
  exitReason: "target" | "stop_loss" | "invalidated" | "open" | "no_next_candle";
  pnlPercent: number | null;
  holdDays: number | null;
};

type OptionTrade = {
  symbol: string;
  direction: "short" | "long";
  label: string;
  optionType: "PUT" | "CALL";
  isSpread: boolean;
  strike: number;
  longStrike: number | null;
  expiryDate: string;
  signalDate: string;
  entryDate: string;
  underlyingEntryPrice: number;
  entryPremium: number;
  exitDate: string | null;
  underlyingExitPrice: number | null;
  exitPremium: number | null;
  settledAtExpiry: boolean;
  underlyingExitReason: string;
  maxLossPerShare: number | null;
  pnlPerShare: number | null;
  pnlPercent: number | null;
  holdDays: number | null;
};

type BacktestResponse = {
  from: string;
  to: string;
  timeframe: "day" | "4h" | "2h";
  symbolCount: number;
  stopLossPercent: number | null;
  directionFilter: "short" | "long" | null;
  sellOptions: boolean;
  spreadWidthPercent: number | null;
  trades: (Trade | OptionTrade)[];
  errors: string[];
};

const TIMEFRAME_LABEL: Record<BacktestResponse["timeframe"], string> = { day: "Daily", "4h": "4H", "2h": "2H" };

function fmt(n: number, digits = 2) {
  return n.toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function csvEscape(value: unknown): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function summarizeStock(trades: Trade[]) {
  const resolved = trades.filter((t) => t.pnlPercent !== null);
  const wins = resolved.filter((t) => (t.pnlPercent as number) > 0);
  const losses = resolved.filter((t) => (t.pnlPercent as number) <= 0);
  const open = trades.length - resolved.length;
  const totalPnl = resolved.reduce((s, t) => s + (t.pnlPercent as number), 0);
  const avgWinPnl = wins.length ? wins.reduce((s, t) => s + (t.pnlPercent as number), 0) / wins.length : 0;
  const avgLossPnl = losses.length ? losses.reduce((s, t) => s + (t.pnlPercent as number), 0) / losses.length : 0;
  const worstPnl = resolved.length ? Math.min(...resolved.map((t) => t.pnlPercent as number)) : 0;
  const bestPnl = resolved.length ? Math.max(...resolved.map((t) => t.pnlPercent as number)) : 0;
  const exitCounts = { target: 0, stop_loss: 0, invalidated: 0 } as Record<string, number>;
  for (const t of trades) {
    if (t.exitReason in exitCounts) exitCounts[t.exitReason]++;
  }
  return {
    total: trades.length,
    resolved: resolved.length,
    wins: wins.length,
    losses: losses.length,
    open,
    winRate: resolved.length ? (wins.length / resolved.length) * 100 : 0,
    avgPnl: resolved.length ? totalPnl / resolved.length : 0,
    totalPnl,
    avgWinPnl,
    avgLossPnl,
    worstPnl,
    bestPnl,
    exitCounts,
  };
}

// Options are aggregated in ₹-per-share terms, not %, because % of a tiny
// (near-zero) premium can blow up into meaningless numbers — a single
// far-OTM sale that goes badly wrong can show a -20,000% "return" on its
// own premium even though the underlying only moved a modest amount. ₹
// terms stay stable and comparable across trades regardless of how small
// the collected premium was.
function summarizeOptions(trades: OptionTrade[]) {
  const resolved = trades.filter((t) => t.pnlPerShare !== null);
  const wins = resolved.filter((t) => (t.pnlPerShare as number) > 0);
  const losses = resolved.filter((t) => (t.pnlPerShare as number) <= 0);
  const open = trades.length - resolved.length;
  const totalPnl = resolved.reduce((s, t) => s + (t.pnlPerShare as number), 0);
  const avgWinPnl = wins.length ? wins.reduce((s, t) => s + (t.pnlPerShare as number), 0) / wins.length : 0;
  const avgLossPnl = losses.length ? losses.reduce((s, t) => s + (t.pnlPerShare as number), 0) / losses.length : 0;
  const worstPnl = resolved.length ? Math.min(...resolved.map((t) => t.pnlPerShare as number)) : 0;
  const bestPnl = resolved.length ? Math.max(...resolved.map((t) => t.pnlPerShare as number)) : 0;
  const expiredCount = trades.filter((t) => t.settledAtExpiry).length;
  const maxLosses = trades.map((t) => t.maxLossPerShare).filter((v): v is number => v !== null);
  const avgMaxLoss = maxLosses.length ? maxLosses.reduce((a, b) => a + b, 0) / maxLosses.length : null;
  return {
    total: trades.length,
    resolved: resolved.length,
    wins: wins.length,
    losses: losses.length,
    open,
    winRate: resolved.length ? (wins.length / resolved.length) * 100 : 0,
    avgPnl: resolved.length ? totalPnl / resolved.length : 0,
    totalPnl,
    avgWinPnl,
    avgLossPnl,
    worstPnl,
    bestPnl,
    expiredCount,
    avgMaxLoss,
  };
}

function toStockCsv(result: BacktestResponse, trades: Trade[], overall: ReturnType<typeof summarizeStock>): string {
  const lines: string[] = [
    "OPSELL Backtest",
    `Timeframe,${TIMEFRAME_LABEL[result.timeframe]}`,
    `Range,${result.from} to ${result.to}`,
    `Symbols,${result.symbolCount}`,
    `Stop loss %,${result.stopLossPercent ?? "none"}`,
    `Direction filter,${result.directionFilter ?? "both"}`,
    `Total trades,${overall.total}`,
    `Resolved,${overall.resolved}`,
    `Wins,${overall.wins}`,
    `Losses,${overall.losses}`,
    `Open,${overall.open}`,
    `Win rate %,${overall.winRate.toFixed(2)}`,
    `Avg P&L % per trade,${overall.avgPnl.toFixed(2)}`,
    `Total P&L % (summed),${overall.totalPnl.toFixed(2)}`,
    `Avg win %,${overall.avgWinPnl.toFixed(2)}`,
    `Avg loss %,${overall.avgLossPnl.toFixed(2)}`,
    `Best trade %,${overall.bestPnl.toFixed(2)}`,
    `Worst trade %,${overall.worstPnl.toFixed(2)}`,
    `Exits — target,${overall.exitCounts.target}`,
    `Exits — stop loss,${overall.exitCounts.stop_loss}`,
    `Exits — invalidated,${overall.exitCounts.invalidated}`,
    "",
    ["Symbol", "Direction", "Label", "SignalDate", "EntryDate", "EntryPrice", "ExitDate", "ExitPrice", "ExitReason", "PnLPercent", "HoldDays"].join(","),
  ];
  for (const t of trades) {
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

function toOptionsCsv(result: BacktestResponse, trades: OptionTrade[], overall: ReturnType<typeof summarizeOptions>): string {
  const lines: string[] = [
    "OPSELL Backtest — Option-selling (MODELED, not real historical premiums)",
    `Timeframe,${TIMEFRAME_LABEL[result.timeframe]}`,
    `Range,${result.from} to ${result.to}`,
    `Symbols,${result.symbolCount}`,
    `Stop loss %,${result.stopLossPercent ?? "none"}`,
    `Direction filter,${result.directionFilter ?? "both"}`,
    "Short leg strike distance,~3% OTM",
    `Spread,${result.spreadWidthPercent ? `credit spread, long leg ~${3 + result.spreadWidthPercent}% OTM (${result.spreadWidthPercent}% wider than the short leg)` : "naked (uncapped downside)"}`,
    "Expiry,Near-month NSE monthly expiry",
    "Pricing,Black-Scholes, volatility estimated from the underlying's own trailing realized volatility",
    `Total trades,${overall.total}`,
    `Resolved,${overall.resolved}`,
    `Wins,${overall.wins}`,
    `Losses,${overall.losses}`,
    `Open,${overall.open}`,
    `Settled at expiry,${overall.expiredCount}`,
    `Win rate %,${overall.winRate.toFixed(2)}`,
    `Avg P&L ₹/share,${overall.avgPnl.toFixed(2)}`,
    `Total P&L ₹/share (summed),${overall.totalPnl.toFixed(2)}`,
    `Avg win ₹/share,${overall.avgWinPnl.toFixed(2)}`,
    `Avg loss ₹/share,${overall.avgLossPnl.toFixed(2)}`,
    `Best trade ₹/share,${overall.bestPnl.toFixed(2)}`,
    `Worst trade ₹/share,${overall.worstPnl.toFixed(2)}`,
    `Avg capped max loss ₹/share,${overall.avgMaxLoss === null ? "n/a (naked)" : overall.avgMaxLoss.toFixed(2)}`,
    "",
    [
      "Symbol", "OptionType", "IsSpread", "ShortStrike", "LongStrike", "ExpiryDate", "Direction", "Label", "SignalDate", "EntryDate",
      "UnderlyingEntryPrice", "EntryPremium", "ExitDate", "UnderlyingExitPrice", "ExitPremium",
      "SettledAtExpiry", "MaxLossPerShare", "PnLPerShare", "PnLPercentOfPremium", "HoldDays",
    ].join(","),
  ];
  for (const t of trades) {
    lines.push(
      [
        t.symbol,
        t.optionType,
        t.isSpread ? "yes" : "no",
        t.strike.toFixed(2),
        t.longStrike === null ? "" : t.longStrike.toFixed(2),
        t.expiryDate,
        t.direction,
        t.label,
        t.signalDate,
        t.entryDate,
        t.underlyingEntryPrice,
        t.entryPremium.toFixed(4),
        t.exitDate ?? "",
        t.underlyingExitPrice ?? "",
        t.exitPremium === null ? "" : t.exitPremium.toFixed(4),
        t.settledAtExpiry ? "yes" : "no",
        t.maxLossPerShare === null ? "" : t.maxLossPerShare.toFixed(4),
        t.pnlPerShare === null ? "" : t.pnlPerShare.toFixed(4),
        t.pnlPercent === null ? "" : t.pnlPercent.toFixed(2),
        t.holdDays === null ? "" : t.holdDays,
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  return lines.join("\n");
}

function downloadCsv(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function BacktestRunner() {
  const [symbolsText, setSymbolsText] = useState("");
  const [timeframe, setTimeframe] = useState<"day" | "4h" | "2h">("day");
  const [stopLossText, setStopLossText] = useState("");
  const [directionFilter, setDirectionFilter] = useState<"both" | "short" | "long">("both");
  const [sellOptions, setSellOptions] = useState(false);
  const [spreadWidthText, setSpreadWidthText] = useState("4");
  const [status, setStatus] = useState<"idle" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResponse | null>(null);

  const stockTrades = useMemo(
    () => (result && !result.sellOptions ? (result.trades as Trade[]) : []),
    [result]
  );
  const optionTrades = useMemo(
    () => (result && result.sellOptions ? (result.trades as OptionTrade[]) : []),
    [result]
  );

  const stockOverall = useMemo(() => (result && !result.sellOptions ? summarizeStock(stockTrades) : null), [result, stockTrades]);
  const optionOverall = useMemo(() => (result && result.sellOptions ? summarizeOptions(optionTrades) : null), [result, optionTrades]);

  const stockPerStock = useMemo(() => {
    if (!result || result.sellOptions) return [];
    const bySymbol = new Map<string, Trade[]>();
    for (const t of stockTrades) {
      const arr = bySymbol.get(t.symbol) ?? [];
      arr.push(t);
      bySymbol.set(t.symbol, arr);
    }
    return Array.from(bySymbol.entries())
      .map(([symbol, trades]) => ({ symbol, ...summarizeStock(trades) }))
      .sort((a, b) => b.totalPnl - a.totalPnl);
  }, [result, stockTrades]);

  const optionPerStock = useMemo(() => {
    if (!result || !result.sellOptions) return [];
    const bySymbol = new Map<string, OptionTrade[]>();
    for (const t of optionTrades) {
      const arr = bySymbol.get(t.symbol) ?? [];
      arr.push(t);
      bySymbol.set(t.symbol, arr);
    }
    return Array.from(bySymbol.entries())
      .map(([symbol, trades]) => ({ symbol, ...summarizeOptions(trades) }))
      .sort((a, b) => b.totalPnl - a.totalPnl);
  }, [result, optionTrades]);

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
    const stopLossPercent = stopLossText.trim() === "" ? undefined : Number(stopLossText);
    if (stopLossPercent !== undefined && (!Number.isFinite(stopLossPercent) || stopLossPercent <= 0)) {
      setError("Stop loss % must be a positive number, or leave it blank for none.");
      setStatus("error");
      return;
    }
    const spreadWidthPercent = spreadWidthText.trim() === "" ? undefined : Number(spreadWidthText);
    if (spreadWidthPercent !== undefined && (!Number.isFinite(spreadWidthPercent) || spreadWidthPercent <= 0)) {
      setError("Spread width % must be a positive number, or leave it blank to sell naked.");
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
        body: JSON.stringify({
          symbols,
          timeframe,
          stopLossPercent,
          directionFilter: directionFilter === "both" ? undefined : directionFilter,
          sellOptions,
          spreadWidthPercent: sellOptions ? spreadWidthPercent : undefined,
        }),
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
        Paste NSE symbols (comma or newline separated) — stocks like RELIANCE, or indices: NIFTY, BANKNIFTY,
        FINNIFTY, MIDCPNIFTY, SENSEX. Walk-forward simulated against the same Supertrend + SMA logic as the
        Strategy tab. Assumptions: entry at next bar&apos;s open after a signal; exit the first bar price touches
        the (moving) target SMA, or (if a stop loss below is set) the first bar price moves that % against entry,
        or the first bar Supertrend flips against the trade if neither of those hit first; trades still
        unresolved after ~90 trading days&apos; worth of bars are marked &quot;open&quot;, not counted as a win
        or loss.
      </p>

      <textarea
        value={symbolsText}
        onChange={(e) => setSymbolsText(e.target.value)}
        placeholder={"RELIANCE\nHDFCBANK\nNIFTY\nBANKNIFTY\n..."}
        rows={5}
        className="mt-3 w-full rounded-lg border border-border bg-surface2 p-3 text-sm"
      />

      <div className="mt-3">
        <span className="block text-xs text-muted">Timeframe</span>
        <div className="mt-1 flex gap-2">
          {(["day", "4h", "2h"] as const).map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => setTimeframe(tf)}
              className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium ${
                timeframe === tf ? "border-accent bg-accent/10 text-accent" : "border-border bg-surface2 text-muted"
              }`}
            >
              {TIMEFRAME_LABEL[tf]}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[10px] text-muted">
          Daily covers ~2 years. 4H/2H are resampled from 60-minute candles, capped by Kite&apos;s ~400-day
          history limit for that interval — roughly the last 13 months instead.
        </p>
      </div>

      <div className="mt-3">
        <span className="block text-xs text-muted">Direction</span>
        <div className="mt-1 flex gap-2">
          {(["both", "short", "long"] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDirectionFilter(d)}
              className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium capitalize ${
                directionFilter === d ? "border-accent bg-accent/10 text-accent" : "border-border bg-surface2 text-muted"
              }`}
            >
              {d === "both" ? "All" : `${d} only`}
            </button>
          ))}
        </div>
      </div>

      <label className="mt-3 block text-xs text-muted">
        Stop loss % from entry (optional — leave blank to use only the Supertrend-flip exit)
        <input
          type="number"
          inputMode="decimal"
          step="0.1"
          min="0"
          value={stopLossText}
          onChange={(e) => setStopLossText(e.target.value)}
          placeholder="e.g. 3"
          className="mt-1 w-full rounded-lg border border-border bg-surface2 p-3 text-sm"
        />
      </label>

      <label className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-surface2 p-3 text-xs">
        <input
          type="checkbox"
          checked={sellOptions}
          onChange={(e) => setSellOptions(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium">Model as option-selling</span> — long signal sells a ~3% OTM put, short
          signal sells a ~3% OTM call, near-month <span className="italic">monthly</span> expiry only (never
          weekly). Premium is a Black-Scholes <span className="italic">estimate</span> off
          the underlying&apos;s own realized volatility — not real historical option prices, since Kite doesn&apos;t
          retain those for expired contracts.
        </span>
      </label>

      {sellOptions && (
        <label className="mt-3 block text-xs text-muted">
          Spread width % (protective leg, this much further OTM than the ~3% short leg — leave blank to sell
          naked/uncapped instead of a credit spread)
          <input
            type="number"
            inputMode="decimal"
            step="0.5"
            min="0"
            value={spreadWidthText}
            onChange={(e) => setSpreadWidthText(e.target.value)}
            placeholder="e.g. 4"
            className="mt-1 w-full rounded-lg border border-border bg-surface2 p-3 text-sm"
          />
        </label>
      )}

      <button
        onClick={run}
        disabled={status === "running"}
        className="mt-3 w-full rounded-xl bg-accent px-4 py-3 text-center text-sm font-medium text-black disabled:opacity-60"
      >
        {status === "running" ? "Running… this can take a minute" : "Run backtest"}
      </button>

      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      {result && stockOverall && !result.sellOptions && (
        <div className="mt-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted">
              {TIMEFRAME_LABEL[result.timeframe]} · {result.symbolCount} symbol{result.symbolCount === 1 ? "" : "s"} ·{" "}
              {result.from} to {result.to} · {result.directionFilter ? `${result.directionFilter} only` : "both directions"} ·{" "}
              {result.stopLossPercent ? `${result.stopLossPercent}% stop loss` : "no stop loss"}
              {result.errors.length > 0 && ` · ${result.errors.length} error(s)`}
            </p>
            <button
              onClick={() => downloadCsv(toStockCsv(result, stockTrades, stockOverall), `opsell-backtest-${result.from}-to-${result.to}.csv`)}
              className="shrink-0 rounded-lg border border-border bg-surface2 px-3 py-1.5 text-xs font-medium"
            >
              Download CSV
            </button>
          </div>

          <div className="mt-3 rounded-xl border border-border bg-surface p-4">
            <div className="grid grid-cols-2 gap-y-2 text-sm">
              <span className="text-muted">Total trades</span>
              <span className="text-right font-medium">{stockOverall.total}</span>
              <span className="text-muted">Resolved (win/loss)</span>
              <span className="text-right font-medium">{stockOverall.resolved}</span>
              <span className="text-muted">Win rate</span>
              <span className="text-right font-medium">{fmt(stockOverall.winRate, 1)}%</span>
              <span className="text-muted">Wins / Losses</span>
              <span className="text-right font-medium">
                {stockOverall.wins} / {stockOverall.losses}
              </span>
              <span className="text-muted">Still open</span>
              <span className="text-right font-medium">{stockOverall.open}</span>
              <span className="text-muted">Avg P&amp;L / trade</span>
              <span className={`text-right font-medium ${stockOverall.avgPnl >= 0 ? "text-accent" : "text-danger"}`}>
                {stockOverall.avgPnl >= 0 ? "+" : ""}
                {fmt(stockOverall.avgPnl)}%
              </span>
              <span className="text-muted">Total P&amp;L (summed)</span>
              <span className={`text-right font-medium ${stockOverall.totalPnl >= 0 ? "text-accent" : "text-danger"}`}>
                {stockOverall.totalPnl >= 0 ? "+" : ""}
                {fmt(stockOverall.totalPnl)}%
              </span>
              <span className="text-muted">Avg win / Avg loss</span>
              <span className="text-right font-medium">
                <span className="text-accent">+{fmt(stockOverall.avgWinPnl)}%</span> /{" "}
                <span className="text-danger">{fmt(stockOverall.avgLossPnl)}%</span>
              </span>
              <span className="text-muted">Best / Worst trade</span>
              <span className="text-right font-medium">
                <span className="text-accent">+{fmt(stockOverall.bestPnl)}%</span> /{" "}
                <span className="text-danger">{fmt(stockOverall.worstPnl)}%</span>
              </span>
              <span className="text-muted">Exits: target / stop / ST-flip</span>
              <span className="text-right font-medium">
                {stockOverall.exitCounts.target} / {stockOverall.exitCounts.stop_loss} / {stockOverall.exitCounts.invalidated}
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
            {stockPerStock.map((s) => (
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
            {stockTrades.map((t, i) => (
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
                  {t.exitDate &&
                    ` · Exit ${t.exitDate} @ ${fmt(t.exitPrice as number)} (${t.exitReason.replace("_", " ")})`}
                  {t.holdDays !== null && ` · ${t.holdDays}${result.timeframe === "day" ? "d" : " bars"}`}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result && optionOverall && result.sellOptions && (
        <div className="mt-5">
          <p className="rounded-lg border border-accent/40 bg-accent/10 p-2.5 text-xs text-accent">
            Modeled option-selling results — Black-Scholes estimates off the underlying&apos;s realized volatility,
            not real historical option premiums. P&amp;L is shown in ₹ per share (not %), since % of a small
            premium can swing wildly and isn&apos;t comparable across trades.
          </p>

          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-muted">
              {TIMEFRAME_LABEL[result.timeframe]} · {result.symbolCount} symbol{result.symbolCount === 1 ? "" : "s"} ·{" "}
              {result.from} to {result.to} · {result.directionFilter ? `${result.directionFilter} only` : "both directions"} ·{" "}
              {result.spreadWidthPercent ? `credit spread (short ~3% / long ~${3 + result.spreadWidthPercent}% OTM)` : "naked (uncapped)"} ·{" "}
              {result.stopLossPercent ? `${result.stopLossPercent}% underlying stop loss` : "no underlying stop loss"}
              {result.errors.length > 0 && ` · ${result.errors.length} error(s)`}
            </p>
            <button
              onClick={() =>
                downloadCsv(toOptionsCsv(result, optionTrades, optionOverall), `opsell-backtest-options-${result.from}-to-${result.to}.csv`)
              }
              className="shrink-0 rounded-lg border border-border bg-surface2 px-3 py-1.5 text-xs font-medium"
            >
              Download CSV
            </button>
          </div>

          <div className="mt-3 rounded-xl border border-border bg-surface p-4">
            <div className="grid grid-cols-2 gap-y-2 text-sm">
              <span className="text-muted">Total trades</span>
              <span className="text-right font-medium">{optionOverall.total}</span>
              <span className="text-muted">Resolved (win/loss)</span>
              <span className="text-right font-medium">{optionOverall.resolved}</span>
              <span className="text-muted">Win rate</span>
              <span className="text-right font-medium">{fmt(optionOverall.winRate, 1)}%</span>
              <span className="text-muted">Wins / Losses</span>
              <span className="text-right font-medium">
                {optionOverall.wins} / {optionOverall.losses}
              </span>
              <span className="text-muted">Still open / Settled at expiry</span>
              <span className="text-right font-medium">
                {optionOverall.open} / {optionOverall.expiredCount}
              </span>
              <span className="text-muted">Avg P&amp;L / trade</span>
              <span className={`text-right font-medium ${optionOverall.avgPnl >= 0 ? "text-accent" : "text-danger"}`}>
                {optionOverall.avgPnl >= 0 ? "+" : ""}
                ₹{fmt(optionOverall.avgPnl)}
              </span>
              <span className="text-muted">Total P&amp;L (summed)</span>
              <span className={`text-right font-medium ${optionOverall.totalPnl >= 0 ? "text-accent" : "text-danger"}`}>
                {optionOverall.totalPnl >= 0 ? "+" : ""}
                ₹{fmt(optionOverall.totalPnl)}
              </span>
              <span className="text-muted">Avg win / Avg loss</span>
              <span className="text-right font-medium">
                <span className="text-accent">+₹{fmt(optionOverall.avgWinPnl)}</span> /{" "}
                <span className="text-danger">₹{fmt(optionOverall.avgLossPnl)}</span>
              </span>
              <span className="text-muted">Best / Worst trade</span>
              <span className="text-right font-medium">
                <span className="text-accent">+₹{fmt(optionOverall.bestPnl)}</span> /{" "}
                <span className="text-danger">₹{fmt(optionOverall.worstPnl)}</span>
              </span>
              {optionOverall.avgMaxLoss !== null && (
                <>
                  <span className="text-muted">Avg capped max loss</span>
                  <span className="text-right font-medium text-danger">₹{fmt(optionOverall.avgMaxLoss)}</span>
                </>
              )}
            </div>
            <p className="mt-2 text-[10px] text-muted">Per-share, one option lot's worth of shares. Not scaled by lot size.</p>
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
            {optionPerStock.map((s) => (
              <li key={s.symbol} className="bg-surface px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{s.symbol}</span>
                  <span className={`text-sm font-semibold ${s.totalPnl >= 0 ? "text-accent" : "text-danger"}`}>
                    {s.totalPnl >= 0 ? "+" : ""}₹{fmt(s.totalPnl)}
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
            {optionTrades.map((t, i) => (
              <li key={i} className="bg-surface px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    {t.symbol} <span className="text-[10px] font-normal text-muted">{t.optionType} {t.label}</span>
                  </span>
                  <span
                    className={`text-sm font-semibold ${
                      t.pnlPerShare === null ? "text-muted" : t.pnlPerShare >= 0 ? "text-accent" : "text-danger"
                    }`}
                  >
                    {t.pnlPerShare === null ? "open" : `${t.pnlPerShare >= 0 ? "+" : ""}₹${fmt(t.pnlPerShare)}`}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-muted">
                  {t.isSpread ? `Short ${fmt(t.strike)} / Long ${fmt(t.longStrike as number)}` : `Strike ${fmt(t.strike)}`} exp{" "}
                  {t.expiryDate} · Net credit {fmt(t.entryPremium, 2)}
                  {t.exitPremium !== null &&
                    ` → Cost to close ${fmt(t.exitPremium, 2)} (${t.settledAtExpiry ? "expiry" : t.underlyingExitReason.replace("_", " ")})`}
                  {t.maxLossPerShare !== null && ` · Max loss ₹${fmt(t.maxLossPerShare)}`}
                  {t.holdDays !== null && ` · ${t.holdDays}${result.timeframe === "day" ? "d" : " bars"}`}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
