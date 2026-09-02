"use client";

import { useState } from "react";

function signedFmt(n: number, digits = 1) {
  return `${n >= 0 ? "+" : ""}${n.toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
}

export default function ReturnCagrToggle({
  returnPercent,
  cagrPercent,
  tradingDayCount,
  daysSinceStart,
  totalPnl,
}: {
  returnPercent: number | null;
  cagrPercent: number | null;
  tradingDayCount: number;
  daysSinceStart: number | null;
  totalPnl: number;
}) {
  const [mode, setMode] = useState<"return" | "cagr">("return");
  const value = mode === "return" ? returnPercent : cagrPercent;
  const colorClass = totalPnl >= 0 ? "text-accent" : "text-danger";

  return (
    <>
      <div className="flex items-center gap-2">
        <div className="inline-flex rounded-lg border border-border p-0.5 text-[11px]">
          <button
            onClick={() => setMode("return")}
            className={`rounded-md px-2 py-0.5 ${mode === "return" ? "bg-surface2 font-medium text-foreground" : "text-muted"}`}
          >
            Return
          </button>
          <button
            onClick={() => setMode("cagr")}
            className={`rounded-md px-2 py-0.5 ${mode === "cagr" ? "bg-surface2 font-medium text-foreground" : "text-muted"}`}
          >
            CAGR
          </button>
        </div>
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <p className={`text-2xl font-semibold ${colorClass}`}>{value !== null ? `${signedFmt(value, 1)}%` : "—"}</p>
        <p className="text-xs text-muted">
          {mode === "return"
            ? `${tradingDayCount} day${tradingDayCount === 1 ? "" : "s"} traded`
            : daysSinceStart !== null
              ? `annualized over ${daysSinceStart} day${daysSinceStart === 1 ? "" : "s"} since first trade`
              : "—"}
        </p>
      </div>
    </>
  );
}
