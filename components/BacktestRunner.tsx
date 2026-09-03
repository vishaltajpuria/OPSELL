"use client";

import { useMemo, useState } from "react";

type Timeframe = "day" | "4h" | "2h";
const ALL_TIMEFRAMES: Timeframe[] = ["day", "4h", "2h"];
const TIMEFRAME_LABEL: Record<Timeframe, string> = { day: "Daily", "4h": "4H", "2h": "2H" };

type Strategy = "smaSupertrend" | "rsiDip";
const STRATEGY_LABEL: Record<Strategy, string> = {
  smaSupertrend: "Supertrend + SMA",
  rsiDip: "RSI Double Dip",
};

type VolumeSpikeCheck = {
  status: "confirmed" | "not_confirmed" | "pending";
  spikeDate: string | null;
  spikeRatio: number | null;
};

type WaveTrendCheck = {
  status: "confirmed" | "not_confirmed" | "pending";
  breachDate: string | null;
  wt2AtBreach: number | null;
};

type Trade = {
  symbol: string;
  timeframe: Timeframe;
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
  // Absent for the RSI Double Dip strategy — see lib/backtest.ts.
  volumeSpike?: VolumeSpikeCheck;
  waveTrend?: WaveTrendCheck;
};

type OptionTrade = {
  symbol: string;
  timeframe: Timeframe;
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
  to: string;
  timeframes: Timeframe[];
  strategy: Strategy;
  symbolCount: number;
  stopLossPercent: number | null;
  directionFilter: "short" | "long" | null;
  sellOptions: boolean;
  spreadWidthPercent: number | null;
  trades: (Trade | OptionTrade)[];
  errors: string[];
};

function fmt(n: number, digits = 2) {
  return n.toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function csvEscape(value: unknown): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function groupByTimeframe<T extends { timeframe: Timeframe }>(trades: T[]): [Timeframe, T[]][] {
  const bucket = new Map<Timeframe, T[]>();
  for (const t of trades) {
    const arr = bucket.get(t.timeframe) ?? [];
    arr.push(t);
    bucket.set(t.timeframe, arr);
  }
  return ALL_TIMEFRAMES.filter((tf) => bucket.has(tf)).map((tf) => [tf, bucket.get(tf) as T[]]);
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

// Splits resolved (win/loss) trades by whether the crossover was backed by
// a volume spike within its own 10-trading-day window (see
// lib/volumeSpike.ts) — the comparison that actually answers "does a
// volume spike make this reversal signal stronger", rather than just
// counting how many signals happened to have one. "pending" trades (the
// 10-day window hasn't finished within the fetched history) are excluded
// from both buckets, not lumped into "not confirmed", since they haven't
// actually failed the check yet.
function summarizeByVolumeSpike(trades: Trade[]) {
  const withCheck = trades.filter((t) => t.volumeSpike && t.volumeSpike.status !== "pending");
  const confirmed = summarizeStock(withCheck.filter((t) => t.volumeSpike!.status === "confirmed"));
  const notConfirmed = summarizeStock(withCheck.filter((t) => t.volumeSpike!.status === "not_confirmed"));
  const pendingCount = trades.filter((t) => t.volumeSpike?.status === "pending").length;
  return { confirmed, notConfirmed, pendingCount, applicable: trades.some((t) => t.volumeSpike !== undefined) };
}

// Same shape as summarizeByVolumeSpike, for the WaveTrend/Market Cipher
// B-style dot check (see lib/waveTrend.ts) — independent of the volume-spike
// split above.
function summarizeByWaveTrend(trades: Trade[]) {
  const withCheck = trades.filter((t) => t.waveTrend && t.waveTrend.status !== "pending");
  const confirmed = summarizeStock(withCheck.filter((t) => t.waveTrend!.status === "confirmed"));
  const notConfirmed = summarizeStock(withCheck.filter((t) => t.waveTrend!.status === "not_confirmed"));
  const pendingCount = trades.filter((t) => t.waveTrend?.status === "pending").length;
  return { confirmed, notConfirmed, pendingCount, applicable: trades.some((t) => t.waveTrend !== undefined) };
}

// The actual "combining volume + WaveTrend makes the signal stronger"
// hypothesis: four buckets by which of the two independently confirmed,
// restricted to trades where BOTH checks have a resolved (non-pending)
// verdict so every bucket is comparing like-for-like. If "both" doesn't
// clearly beat "neither"/"one", stacking the two doesn't actually add up to
// something stronger — it just looks like it should.
function summarizeByConfluence(trades: Trade[]) {
  const withBoth = trades.filter(
    (t) => t.volumeSpike && t.volumeSpike.status !== "pending" && t.waveTrend && t.waveTrend.status !== "pending"
  );
  const bucket = (vol: boolean, wt: boolean) =>
    summarizeStock(
      withBoth.filter((t) => (t.volumeSpike!.status === "confirmed") === vol && (t.waveTrend!.status === "confirmed") === wt)
    );
  return {
    both: bucket(true, true),
    volOnly: bucket(true, false),
    wtOnly: bucket(false, true),
    neither: bucket(false, false),
    applicable: withBoth.length > 0,
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

function toStockCsv(result: BacktestResponse, trades: Trade[]): string {
  const lines: string[] = [
    "OPSELL Backtest",
    `Strategy,${STRATEGY_LABEL[result.strategy]}`,
    `Timeframes,${result.timeframes.map((tf) => TIMEFRAME_LABEL[tf]).join(" + ")}`,
    `As of,${result.to}`,
    `Symbols,${result.symbolCount}`,
    `Stop loss %,${result.stopLossPercent ?? "none"}`,
    `Direction filter,${result.directionFilter ?? "both"}`,
    "",
  ];
  for (const [tf, tfTrades] of groupByTimeframe(trades)) {
    const overall = summarizeStock(tfTrades);
    lines.push(
      `--- ${TIMEFRAME_LABEL[tf]} ---`,
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
      ""
    );

    if (tfTrades.some((t) => t.volumeSpike !== undefined)) {
      const split = summarizeByVolumeSpike(tfTrades);
      lines.push(
        `--- ${TIMEFRAME_LABEL[tf]}: volume-spike confirmed vs. not ---`,
        `,Confirmed,Not confirmed`,
        `Trades (resolved),${split.confirmed.resolved},${split.notConfirmed.resolved}`,
        `Win rate %,${split.confirmed.winRate.toFixed(2)},${split.notConfirmed.winRate.toFixed(2)}`,
        `Avg P&L % per trade,${split.confirmed.avgPnl.toFixed(2)},${split.notConfirmed.avgPnl.toFixed(2)}`,
        `Total P&L % (summed),${split.confirmed.totalPnl.toFixed(2)},${split.notConfirmed.totalPnl.toFixed(2)}`,
        `Pending (window not finished),${split.pendingCount},`,
        ""
      );
    }

    if (tfTrades.some((t) => t.waveTrend !== undefined)) {
      const split = summarizeByWaveTrend(tfTrades);
      lines.push(
        `--- ${TIMEFRAME_LABEL[tf]}: WaveTrend threshold confirmed vs. not ---`,
        `,Confirmed,Not confirmed`,
        `Trades (resolved),${split.confirmed.resolved},${split.notConfirmed.resolved}`,
        `Win rate %,${split.confirmed.winRate.toFixed(2)},${split.notConfirmed.winRate.toFixed(2)}`,
        `Avg P&L % per trade,${split.confirmed.avgPnl.toFixed(2)},${split.notConfirmed.avgPnl.toFixed(2)}`,
        `Total P&L % (summed),${split.confirmed.totalPnl.toFixed(2)},${split.notConfirmed.totalPnl.toFixed(2)}`,
        `Pending (window not finished),${split.pendingCount},`,
        ""
      );
    }

    const confluence = summarizeByConfluence(tfTrades);
    if (confluence.applicable) {
      lines.push(
        `--- ${TIMEFRAME_LABEL[tf]}: confluence (volume + WaveTrend) ---`,
        `,Both,Vol only,WT only,Neither`,
        `Trades (resolved),${confluence.both.resolved},${confluence.volOnly.resolved},${confluence.wtOnly.resolved},${confluence.neither.resolved}`,
        `Win rate %,${confluence.both.winRate.toFixed(2)},${confluence.volOnly.winRate.toFixed(2)},${confluence.wtOnly.winRate.toFixed(2)},${confluence.neither.winRate.toFixed(2)}`,
        `Avg P&L % per trade,${confluence.both.avgPnl.toFixed(2)},${confluence.volOnly.avgPnl.toFixed(2)},${confluence.wtOnly.avgPnl.toFixed(2)},${confluence.neither.avgPnl.toFixed(2)}`,
        ""
      );
    }
  }
  lines.push(
    [
      "Timeframe",
      "Symbol",
      "Direction",
      "Label",
      "SignalDate",
      "EntryDate",
      "EntryPrice",
      "ExitDate",
      "ExitPrice",
      "ExitReason",
      "PnLPercent",
      "HoldBars",
      "VolumeSpikeStatus",
      "VolumeSpikeDate",
      "VolumeSpikeRatio",
      "WaveTrendStatus",
      "WaveTrendBreachDate",
      "WaveTrendWt2AtBreach",
    ].join(",")
  );
  for (const t of trades) {
    lines.push(
      [
        TIMEFRAME_LABEL[t.timeframe],
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
        t.volumeSpike?.status ?? "",
        t.volumeSpike?.spikeDate ?? "",
        t.volumeSpike?.spikeRatio === null || t.volumeSpike?.spikeRatio === undefined
          ? ""
          : t.volumeSpike.spikeRatio.toFixed(2),
        t.waveTrend?.status ?? "",
        t.waveTrend?.breachDate ?? "",
        t.waveTrend?.wt2AtBreach === null || t.waveTrend?.wt2AtBreach === undefined
          ? ""
          : t.waveTrend.wt2AtBreach.toFixed(2),
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  return lines.join("\n");
}

function toOptionsCsv(result: BacktestResponse, trades: OptionTrade[]): string {
  const lines: string[] = [
    "OPSELL Backtest — Option-selling (MODELED, not real historical premiums)",
    `Strategy,${STRATEGY_LABEL[result.strategy]}`,
    `Timeframes,${result.timeframes.map((tf) => TIMEFRAME_LABEL[tf]).join(" + ")}`,
    `As of,${result.to}`,
    `Symbols,${result.symbolCount}`,
    `Stop loss %,${result.stopLossPercent ?? "none"}`,
    `Direction filter,${result.directionFilter ?? "both"}`,
    "Short leg strike distance,~3% OTM",
    `Spread,${result.spreadWidthPercent ? `credit spread, long leg ~${3 + result.spreadWidthPercent}% OTM (${result.spreadWidthPercent}% wider than the short leg)` : "naked (uncapped downside)"}`,
    "Expiry,Near-month NSE monthly expiry",
    "Pricing,Black-Scholes, volatility estimated from the underlying's own trailing realized volatility",
    "",
  ];
  for (const [tf, tfTrades] of groupByTimeframe(trades)) {
    const overall = summarizeOptions(tfTrades);
    lines.push(
      `--- ${TIMEFRAME_LABEL[tf]} ---`,
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
      ""
    );
  }
  lines.push(
    [
      "Timeframe", "Symbol", "OptionType", "IsSpread", "ShortStrike", "LongStrike", "ExpiryDate", "Direction", "Label", "SignalDate", "EntryDate",
      "UnderlyingEntryPrice", "EntryPremium", "ExitDate", "UnderlyingExitPrice", "ExitPremium",
      "SettledAtExpiry", "MaxLossPerShare", "PnLPerShare", "PnLPercentOfPremium", "HoldBars",
    ].join(",")
  );
  for (const t of trades) {
    lines.push(
      [
        TIMEFRAME_LABEL[t.timeframe],
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

function StockResultBlock({ timeframe, trades }: { timeframe: Timeframe; trades: Trade[] }) {
  const overall = summarizeStock(trades);
  const volumeSplit = useMemo(() => summarizeByVolumeSpike(trades), [trades]);
  const waveTrendSplit = useMemo(() => summarizeByWaveTrend(trades), [trades]);
  const confluence = useMemo(() => summarizeByConfluence(trades), [trades]);
  const perStock = useMemo(() => {
    const bySymbol = new Map<string, Trade[]>();
    for (const t of trades) {
      const arr = bySymbol.get(t.symbol) ?? [];
      arr.push(t);
      bySymbol.set(t.symbol, arr);
    }
    return Array.from(bySymbol.entries())
      .map(([symbol, ts]) => ({ symbol, ...summarizeStock(ts) }))
      .sort((a, b) => b.totalPnl - a.totalPnl);
  }, [trades]);

  return (
    <div className="mt-5">
      <h2 className="text-sm font-semibold">{TIMEFRAME_LABEL[timeframe]}</h2>

      <div className="mt-2 rounded-xl border border-border bg-surface p-4">
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
          <span className="text-muted">Avg win / Avg loss</span>
          <span className="text-right font-medium">
            <span className="text-accent">+{fmt(overall.avgWinPnl)}%</span> /{" "}
            <span className="text-danger">{fmt(overall.avgLossPnl)}%</span>
          </span>
          <span className="text-muted">Best / Worst trade</span>
          <span className="text-right font-medium">
            <span className="text-accent">+{fmt(overall.bestPnl)}%</span> /{" "}
            <span className="text-danger">{fmt(overall.worstPnl)}%</span>
          </span>
          <span className="text-muted">Exits: target / stop / ST-flip</span>
          <span className="text-right font-medium">
            {overall.exitCounts.target} / {overall.exitCounts.stop_loss} / {overall.exitCounts.invalidated}
          </span>
        </div>
      </div>

      {volumeSplit.applicable && (
        <div className="mt-3 rounded-xl border border-amber-400/40 bg-surface p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
            Volume-spike confirmed vs. not (10 trading days after crossover, ≥50% over 30-day avg)
          </h3>
          <div className="mt-2 grid grid-cols-3 gap-x-2 gap-y-1.5 text-sm">
            <span></span>
            <span className="text-right text-[11px] text-muted">Confirmed</span>
            <span className="text-right text-[11px] text-muted">Not confirmed</span>

            <span className="text-muted">Trades (resolved)</span>
            <span className="text-right font-medium">{volumeSplit.confirmed.resolved}</span>
            <span className="text-right font-medium">{volumeSplit.notConfirmed.resolved}</span>

            <span className="text-muted">Win rate</span>
            <span className="text-right font-medium">{fmt(volumeSplit.confirmed.winRate, 1)}%</span>
            <span className="text-right font-medium">{fmt(volumeSplit.notConfirmed.winRate, 1)}%</span>

            <span className="text-muted">Avg P&amp;L / trade</span>
            <span
              className={`text-right font-medium ${volumeSplit.confirmed.avgPnl >= 0 ? "text-accent" : "text-danger"}`}
            >
              {volumeSplit.confirmed.avgPnl >= 0 ? "+" : ""}
              {fmt(volumeSplit.confirmed.avgPnl)}%
            </span>
            <span
              className={`text-right font-medium ${volumeSplit.notConfirmed.avgPnl >= 0 ? "text-accent" : "text-danger"}`}
            >
              {volumeSplit.notConfirmed.avgPnl >= 0 ? "+" : ""}
              {fmt(volumeSplit.notConfirmed.avgPnl)}%
            </span>
          </div>
          {volumeSplit.pendingCount > 0 && (
            <p className="mt-2 text-[11px] text-muted">
              {volumeSplit.pendingCount} trade(s) excluded — signal too close to the end of the fetched history for
              the 10-day window to have finished.
            </p>
          )}
        </div>
      )}

      {waveTrendSplit.applicable && (
        <div className="mt-3 rounded-xl border border-sky-400/40 bg-surface p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
            WaveTrend confirmed vs. not (wt2 beyond ±60 within 10 trading days either side of crossover)
          </h3>
          <div className="mt-2 grid grid-cols-3 gap-x-2 gap-y-1.5 text-sm">
            <span></span>
            <span className="text-right text-[11px] text-muted">Confirmed</span>
            <span className="text-right text-[11px] text-muted">Not confirmed</span>

            <span className="text-muted">Trades (resolved)</span>
            <span className="text-right font-medium">{waveTrendSplit.confirmed.resolved}</span>
            <span className="text-right font-medium">{waveTrendSplit.notConfirmed.resolved}</span>

            <span className="text-muted">Win rate</span>
            <span className="text-right font-medium">{fmt(waveTrendSplit.confirmed.winRate, 1)}%</span>
            <span className="text-right font-medium">{fmt(waveTrendSplit.notConfirmed.winRate, 1)}%</span>

            <span className="text-muted">Avg P&amp;L / trade</span>
            <span
              className={`text-right font-medium ${waveTrendSplit.confirmed.avgPnl >= 0 ? "text-accent" : "text-danger"}`}
            >
              {waveTrendSplit.confirmed.avgPnl >= 0 ? "+" : ""}
              {fmt(waveTrendSplit.confirmed.avgPnl)}%
            </span>
            <span
              className={`text-right font-medium ${waveTrendSplit.notConfirmed.avgPnl >= 0 ? "text-accent" : "text-danger"}`}
            >
              {waveTrendSplit.notConfirmed.avgPnl >= 0 ? "+" : ""}
              {fmt(waveTrendSplit.notConfirmed.avgPnl)}%
            </span>
          </div>
          {waveTrendSplit.pendingCount > 0 && (
            <p className="mt-2 text-[11px] text-muted">
              {waveTrendSplit.pendingCount} trade(s) excluded — signal too close to the end of the fetched history
              for the 10-day window to have finished.
            </p>
          )}
        </div>
      )}

      {confluence.applicable && (
        <div className="mt-3 rounded-xl border border-border bg-surface p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
            Confluence — does stacking volume + WaveTrend actually help?
          </h3>
          <div className="mt-2 overflow-x-auto">
            <div className="grid min-w-[420px] grid-cols-5 gap-x-2 gap-y-1.5 text-sm">
              <span></span>
              <span className="text-right text-[11px] text-muted">Both</span>
              <span className="text-right text-[11px] text-muted">Vol only</span>
              <span className="text-right text-[11px] text-muted">WT only</span>
              <span className="text-right text-[11px] text-muted">Neither</span>

              <span className="text-muted">Trades</span>
              <span className="text-right font-medium">{confluence.both.resolved}</span>
              <span className="text-right font-medium">{confluence.volOnly.resolved}</span>
              <span className="text-right font-medium">{confluence.wtOnly.resolved}</span>
              <span className="text-right font-medium">{confluence.neither.resolved}</span>

              <span className="text-muted">Win rate</span>
              <span className="text-right font-medium">{fmt(confluence.both.winRate, 1)}%</span>
              <span className="text-right font-medium">{fmt(confluence.volOnly.winRate, 1)}%</span>
              <span className="text-right font-medium">{fmt(confluence.wtOnly.winRate, 1)}%</span>
              <span className="text-right font-medium">{fmt(confluence.neither.winRate, 1)}%</span>

              <span className="text-muted">Avg P&amp;L</span>
              {[confluence.both, confluence.volOnly, confluence.wtOnly, confluence.neither].map((b, i) => (
                <span key={i} className={`text-right font-medium ${b.avgPnl >= 0 ? "text-accent" : "text-danger"}`}>
                  {b.avgPnl >= 0 ? "+" : ""}
                  {fmt(b.avgPnl)}%
                </span>
              ))}
            </div>
          </div>
          <p className="mt-2 text-[11px] text-muted">
            Restricted to trades where both checks have a finished (non-pending) verdict, so every column is
            comparing the same population.
          </p>
        </div>
      )}

      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">Per stock</h3>
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

      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">All trades</h3>
      <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
        {trades.map((t, i) => (
          <li key={i} className="bg-surface px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="font-medium">
                {t.symbol} <span className="text-[10px] font-normal text-muted">{t.label}</span>
                {t.volumeSpike?.status === "confirmed" && (
                  <span
                    className="ml-1.5 text-[9px] font-semibold uppercase text-amber-400"
                    title={`Volume spike ${t.volumeSpike.spikeRatio?.toFixed(1)}x the 30-day average on ${t.volumeSpike.spikeDate}`}
                  >
                    Vol ✓
                  </span>
                )}
                {t.waveTrend?.status === "confirmed" && (
                  <span
                    className="ml-1.5 text-[9px] font-semibold uppercase text-sky-400"
                    title={`WaveTrend ${t.direction === "long" ? "oversold" : "overbought"} breach on ${t.waveTrend.breachDate}, wt2=${t.waveTrend.wt2AtBreach?.toFixed(0)}`}
                  >
                    WT ✓
                  </span>
                )}
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
              {t.exitDate && ` · Exit ${t.exitDate} @ ${fmt(t.exitPrice as number)} (${t.exitReason.replace("_", " ")})`}
              {t.holdDays !== null && ` · ${t.holdDays}${timeframe === "day" ? "d" : " bars"}`}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OptionResultBlock({ timeframe, trades }: { timeframe: Timeframe; trades: OptionTrade[] }) {
  const overall = summarizeOptions(trades);
  const perStock = useMemo(() => {
    const bySymbol = new Map<string, OptionTrade[]>();
    for (const t of trades) {
      const arr = bySymbol.get(t.symbol) ?? [];
      arr.push(t);
      bySymbol.set(t.symbol, arr);
    }
    return Array.from(bySymbol.entries())
      .map(([symbol, ts]) => ({ symbol, ...summarizeOptions(ts) }))
      .sort((a, b) => b.totalPnl - a.totalPnl);
  }, [trades]);

  return (
    <div className="mt-5">
      <h2 className="text-sm font-semibold">{TIMEFRAME_LABEL[timeframe]}</h2>

      <div className="mt-2 rounded-xl border border-border bg-surface p-4">
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
          <span className="text-muted">Still open / Settled at expiry</span>
          <span className="text-right font-medium">
            {overall.open} / {overall.expiredCount}
          </span>
          <span className="text-muted">Avg P&amp;L / trade</span>
          <span className={`text-right font-medium ${overall.avgPnl >= 0 ? "text-accent" : "text-danger"}`}>
            {overall.avgPnl >= 0 ? "+" : ""}
            ₹{fmt(overall.avgPnl)}
          </span>
          <span className="text-muted">Total P&amp;L (summed)</span>
          <span className={`text-right font-medium ${overall.totalPnl >= 0 ? "text-accent" : "text-danger"}`}>
            {overall.totalPnl >= 0 ? "+" : ""}
            ₹{fmt(overall.totalPnl)}
          </span>
          <span className="text-muted">Avg win / Avg loss</span>
          <span className="text-right font-medium">
            <span className="text-accent">+₹{fmt(overall.avgWinPnl)}</span> /{" "}
            <span className="text-danger">₹{fmt(overall.avgLossPnl)}</span>
          </span>
          <span className="text-muted">Best / Worst trade</span>
          <span className="text-right font-medium">
            <span className="text-accent">+₹{fmt(overall.bestPnl)}</span> /{" "}
            <span className="text-danger">₹{fmt(overall.worstPnl)}</span>
          </span>
          {overall.avgMaxLoss !== null && (
            <>
              <span className="text-muted">Avg capped max loss</span>
              <span className="text-right font-medium text-danger">₹{fmt(overall.avgMaxLoss)}</span>
            </>
          )}
        </div>
        <p className="mt-2 text-[10px] text-muted">Per-share, one option lot's worth of shares. Not scaled by lot size.</p>
      </div>

      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">Per stock</h3>
      <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
        {perStock.map((s) => (
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

      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">All trades</h3>
      <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
        {trades.map((t, i) => (
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
              {t.holdDays !== null && ` · ${t.holdDays}${timeframe === "day" ? "d" : " bars"}`}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function BacktestRunner() {
  const [symbolsText, setSymbolsText] = useState("");
  const [strategy, setStrategy] = useState<Strategy>("smaSupertrend");
  const [timeframes, setTimeframes] = useState<Set<Timeframe>>(new Set(["day"]));
  const [stopLossText, setStopLossText] = useState("");
  const [directionFilter, setDirectionFilter] = useState<"both" | "short" | "long">("both");
  const [sellOptions, setSellOptions] = useState(false);
  const [spreadWidthText, setSpreadWidthText] = useState("4");
  const [status, setStatus] = useState<"idle" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResponse | null>(null);
  const [universeStatus, setUniverseStatus] = useState<"idle" | "loading" | "error">("idle");

  const stockGroups = useMemo(
    () => (result && !result.sellOptions ? groupByTimeframe(result.trades as Trade[]) : []),
    [result]
  );
  const optionGroups = useMemo(
    () => (result && result.sellOptions ? groupByTimeframe(result.trades as OptionTrade[]) : []),
    [result]
  );

  // ~50s at Kite's 3 req/sec per (symbol, timeframe) request — keeps a
  // single run under Vercel's 60s cap. Selecting more timeframes multiplies
  // the request count, so the safe symbol count shrinks accordingly.
  const MAX_WORK_ITEMS = 150;

  // Pulls the same live F&O stock list the daily scan itself uses (fetched
  // fresh from Kite's instrument dump, not a hand-typed/hardcoded one that
  // would drift out of date as NSE adds/removes F&O-eligible names). Doesn't
  // include indices — this is specifically "the full stock universe";
  // NIFTY/BANKNIFTY/etc. can still be added by hand alongside it.
  //
  // Split into two roughly-equal halves rather than one ~211-name dump: the
  // full list alone already exceeds MAX_WORK_ITEMS for even a single
  // timeframe, and manually trimming a 200+-line list on a phone isn't
  // practical — half.total splits it once (evenly) rather than everyone
  // recomputing their own midpoint.
  async function loadFnoHalf(half: 1 | 2) {
    setUniverseStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/instruments");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load the F&O stock list.");
      const names: string[] = (data.stocks ?? []).map((s: { name: string }) => s.name);
      const mid = Math.ceil(names.length / 2);
      const slice = half === 1 ? names.slice(0, mid) : names.slice(mid);
      setSymbolsText(slice.join("\n"));
      setUniverseStatus("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setUniverseStatus("error");
    }
  }

  function toggleTimeframe(tf: Timeframe) {
    setTimeframes((prev) => {
      const next = new Set(prev);
      if (next.has(tf)) {
        if (next.size > 1) next.delete(tf); // keep at least one selected
      } else {
        next.add(tf);
      }
      return next;
    });
  }

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
    const workItems = symbols.length * timeframes.size;
    if (workItems > MAX_WORK_ITEMS) {
      const maxSymbolsForSelection = Math.floor(MAX_WORK_ITEMS / timeframes.size);
      setError(
        `${symbols.length} symbols × ${timeframes.size} timeframe(s) = ${workItems} requests, over the ${MAX_WORK_ITEMS} limit. With this many timeframes selected, use ${maxSymbolsForSelection} symbols or fewer (or select fewer timeframes).`
      );
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
          strategy,
          timeframes: Array.from(timeframes),
          stopLossPercent,
          directionFilter: strategy === "smaSupertrend" && directionFilter !== "both" ? directionFilter : undefined,
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
        FINNIFTY, MIDCPNIFTY, SENSEX.
      </p>

      <div className="mt-3">
        <span className="block text-xs text-muted">Strategy</span>
        <div className="mt-1 flex gap-2">
          {(["smaSupertrend", "rsiDip"] as Strategy[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStrategy(s)}
              className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium ${
                strategy === s ? "border-accent bg-accent/10 text-accent" : "border-border bg-surface2 text-muted"
              }`}
            >
              {STRATEGY_LABEL[s]}
            </button>
          ))}
        </div>
        {strategy === "smaSupertrend" ? (
          <p className="mt-1 text-[10px] text-muted">
            Walk-forward simulated against the same Supertrend + SMA logic as the Strategy tab. Assumptions:
            entry at next bar&apos;s open after a signal; exit the first bar price touches the (moving) target
            SMA, or (if a stop loss below is set) the first bar price moves that % against entry, or the first
            bar Supertrend flips against the trade if neither of those hit first; trades still unresolved after
            ~90 trading days&apos; worth of bars are marked &quot;open&quot;, not counted as a win or loss.
          </p>
        ) : (
          <p className="mt-1 text-[10px] text-muted">
            Long only. RSI(10) crossing above its own 10-period SMA counts as a &quot;dip&quot; while RSI is
            still below 50 (crossing back above 50 resets the count); the 2nd such crossover (a double bottom)
            enters at the next bar&apos;s open. Exits on the first bar Supertrend(10, 2.5) flips from an uptrend
            to a downtrend — computed on real OHLC, not Heikin Ashi. No target exit exists in this strategy; a
            stop loss below is optional (not part of the source script). Trades still unresolved after ~90
            trading days&apos; worth of bars are marked &quot;open&quot;.
          </p>
        )}
      </div>

      <textarea
        value={symbolsText}
        onChange={(e) => setSymbolsText(e.target.value)}
        placeholder={"RELIANCE\nHDFCBANK\nNIFTY\nBANKNIFTY\n..."}
        rows={5}
        className="mt-3 w-full rounded-lg border border-border bg-surface2 p-3 text-sm"
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => loadFnoHalf(1)}
          disabled={universeStatus === "loading"}
          className="flex-1 rounded-lg border border-border bg-surface2 px-3 py-2 text-xs font-medium text-muted disabled:opacity-60"
        >
          {universeStatus === "loading" ? "Loading…" : "Load F&O list (1st half)"}
        </button>
        <button
          type="button"
          onClick={() => loadFnoHalf(2)}
          disabled={universeStatus === "loading"}
          className="flex-1 rounded-lg border border-border bg-surface2 px-3 py-2 text-xs font-medium text-muted disabled:opacity-60"
        >
          {universeStatus === "loading" ? "Loading…" : "Load F&O list (2nd half)"}
        </button>
      </div>
      <p className="mt-1 text-[10px] text-muted">
        Fetches the live list (~200+ stocks) straight from Kite, same as the daily scan uses, split into two
        halves — the full list alone is already over the {MAX_WORK_ITEMS}-request run cap for even one
        timeframe. Run each half separately (with Daily only, both halves fit comfortably under the cap) and
        add the results together.
      </p>

      <div className="mt-3">
        <span className="block text-xs text-muted">Timeframe (tap to select more than one)</span>
        <div className="mt-1 flex gap-2">
          {ALL_TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => toggleTimeframe(tf)}
              className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium ${
                timeframes.has(tf) ? "border-accent bg-accent/10 text-accent" : "border-border bg-surface2 text-muted"
              }`}
            >
              {TIMEFRAME_LABEL[tf]}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[10px] text-muted">
          Daily covers ~2 years. 4H/2H are resampled from 60-minute candles, capped by Kite&apos;s ~400-day
          history limit for that interval — roughly the last 13 months instead. Selecting more than one
          timeframe fetches each separately, so the safe symbol count shrinks — e.g. up to {Math.floor(MAX_WORK_ITEMS / 3)} symbols
          with all three selected.
        </p>
      </div>

      {strategy === "smaSupertrend" && (
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
      )}

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

      {result && !result.sellOptions && (
        <div className="mt-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted">
              {STRATEGY_LABEL[result.strategy]} · {result.timeframes.map((tf) => TIMEFRAME_LABEL[tf]).join(" + ")} ·{" "}
              {result.symbolCount} symbol
              {result.symbolCount === 1 ? "" : "s"} · as of {result.to} ·{" "}
              {result.strategy === "rsiDip" ? "long only" : result.directionFilter ? `${result.directionFilter} only` : "both directions"} ·{" "}
              {result.stopLossPercent ? `${result.stopLossPercent}% stop loss` : "no stop loss"}
              {result.errors.length > 0 && ` · ${result.errors.length} error(s)`}
            </p>
            <button
              onClick={() => downloadCsv(toStockCsv(result, result.trades as Trade[]), `opsell-backtest-${result.to}.csv`)}
              className="shrink-0 rounded-lg border border-border bg-surface2 px-3 py-1.5 text-xs font-medium"
            >
              Download CSV
            </button>
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

          {stockGroups.map(([tf, trades]) => (
            <StockResultBlock key={tf} timeframe={tf} trades={trades} />
          ))}
        </div>
      )}

      {result && result.sellOptions && (
        <div className="mt-5">
          <p className="rounded-lg border border-accent/40 bg-accent/10 p-2.5 text-xs text-accent">
            Modeled option-selling results — Black-Scholes estimates off the underlying&apos;s realized volatility,
            not real historical option premiums. P&amp;L is shown in ₹ per share (not %), since % of a small
            premium can swing wildly and isn&apos;t comparable across trades.
          </p>

          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-muted">
              {STRATEGY_LABEL[result.strategy]} · {result.timeframes.map((tf) => TIMEFRAME_LABEL[tf]).join(" + ")} ·{" "}
              {result.symbolCount} symbol
              {result.symbolCount === 1 ? "" : "s"} · as of {result.to} ·{" "}
              {result.strategy === "rsiDip" ? "long only" : result.directionFilter ? `${result.directionFilter} only` : "both directions"} ·{" "}
              {result.spreadWidthPercent ? `credit spread (short ~3% / long ~${3 + result.spreadWidthPercent}% OTM)` : "naked (uncapped)"} ·{" "}
              {result.stopLossPercent ? `${result.stopLossPercent}% underlying stop loss` : "no underlying stop loss"}
              {result.errors.length > 0 && ` · ${result.errors.length} error(s)`}
            </p>
            <button
              onClick={() => downloadCsv(toOptionsCsv(result, result.trades as OptionTrade[]), `opsell-backtest-options-${result.to}.csv`)}
              className="shrink-0 rounded-lg border border-border bg-surface2 px-3 py-1.5 text-xs font-medium"
            >
              Download CSV
            </button>
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

          {optionGroups.map(([tf, trades]) => (
            <OptionResultBlock key={tf} timeframe={tf} trades={trades} />
          ))}
        </div>
      )}
    </div>
  );
}
