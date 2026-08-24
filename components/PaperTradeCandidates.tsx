"use client";

import { useState } from "react";

type StoredSignal = {
  symbol: string;
  timeframe: "1D" | "4H";
  direction: "short" | "long";
  signalDate: string;
  entryPrice: number;
  supertrendValue: number;
  triggerSma: { period: number; value: number };
  targetSma: { period: number; value: number };
};

type PaperTradeLeg = { tradingsymbol: string; strike: number; optionType: "CE" | "PE" };
type TradePlanLeg = PaperTradeLeg & { premium: number; lotSize: number };

type FreshPlan = {
  isIncrease: false;
  symbol: string;
  direction: "short" | "long";
  mode: "buy" | "sell";
  expiry: string;
  tradingSessionsUntilExpiry: number;
  usedNextMonth: boolean;
  underlyingPrice: number;
  shortLeg: TradePlanLeg;
  longLeg: TradePlanLeg | null;
  entryPremium: number;
};

type IncreasePlan = {
  isIncrease: true;
  symbol: string;
  direction: "short" | "long";
  mode: "buy" | "sell";
  expiry: string;
  existingLots: number;
  existingEntryPremium: number;
  underlyingPrice: number;
  currentPremium: number;
  shortLeg: PaperTradeLeg;
  longLeg: PaperTradeLeg | null;
  lotSize: number;
};

type PlanResponse = FreshPlan | IncreasePlan;

function fmt(n: number, digits = 2) {
  return n.toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function signalLabel(s: Pick<StoredSignal, "direction" | "triggerSma">): string {
  const base = s.direction === "short" ? "Short" : "Long";
  const isSuper = s.triggerSma.period === 50 || s.triggerSma.period === 100;
  return isSuper ? `Super ${base}` : base;
}

function legLabel(leg: PaperTradeLeg) {
  return `${leg.strike.toFixed(0)}${leg.optionType}`;
}

// Same reasoning as the Strategy tab's own sort: the % distance from entry
// to the target SMA is the maximum move the setup is pointing at. Sorted
// largest first so the most promising candidates surface at the top instead
// of leaving a long list in scan order.
function targetGapPercent(s: StoredSignal): number {
  return (Math.abs(s.targetSma.value - s.entryPrice) / s.entryPrice) * 100;
}

type Preview = {
  symbol: string;
  direction: "short" | "long";
  mode: "buy" | "sell";
  status: "loading" | "ready" | "confirming" | "confirmed" | "error";
  plan: PlanResponse | null;
  error: string | null;
  lotsText: string;
};

export default function PaperTradeCandidates({
  candidates,
  runAt,
}: {
  candidates: StoredSignal[];
  runAt: string | null;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const sorted = [...candidates].sort((a, b) => targetGapPercent(b) - targetGapPercent(a));

  async function openPreview(symbol: string, direction: "short" | "long", mode: "buy" | "sell") {
    setPreview({ symbol, direction, mode, status: "loading", plan: null, error: null, lotsText: "1" });
    try {
      const res = await fetch("/api/papertrade/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, direction, mode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to build a trade plan.");
      setPreview({ symbol, direction, mode, status: "ready", plan: data, error: null, lotsText: "1" });
    } catch (err) {
      setPreview({
        symbol,
        direction,
        mode,
        status: "error",
        plan: null,
        error: err instanceof Error ? err.message : String(err),
        lotsText: "1",
      });
    }
  }

  async function confirmTrade() {
    if (!preview || !preview.plan) return;
    const lots = Number(preview.lotsText);
    if (!Number.isInteger(lots) || lots <= 0) {
      setPreview({ ...preview, status: "error", error: "Lots must be a positive whole number." });
      return;
    }
    setPreview({ ...preview, status: "confirming" });
    try {
      const endpoint = preview.plan.isIncrease ? "/api/papertrade/increase" : "/api/papertrade/start";
      const body = preview.plan.isIncrease
        ? { symbol: preview.symbol, mode: preview.mode, lots }
        : { symbol: preview.symbol, direction: preview.direction, mode: preview.mode, lots };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to submit the trade.");
      setPreview({ ...preview, status: "confirmed" });
    } catch (err) {
      setPreview({ ...preview, status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div>
      <p className="text-xs text-muted">
        {runAt
          ? `Candidates from the ${new Date(runAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} IST run, sorted by biggest entry→target move first.`
          : "No candidates yet — run the Strategy scan first."}
      </p>

      {preview && (
        <div className="mt-3 rounded-xl border border-accent/50 bg-accent/5 p-3">
          <p className="text-sm font-semibold">
            {preview.symbol} · {preview.mode === "buy" ? "Buy" : "Sell"} · {preview.direction}
            {preview.plan?.isIncrease && " · adding to existing position"}
          </p>
          {preview.status === "loading" && <p className="mt-2 text-xs text-muted">Fetching live option chain…</p>}
          {preview.status === "error" && <p className="mt-2 text-xs text-danger">{preview.error}</p>}
          {preview.status === "confirmed" && (
            <p className="mt-2 text-xs text-accent">
              {preview.plan?.isIncrease ? "Position increased" : "Trade opened"} — check the Positions tab.
            </p>
          )}
          {preview.plan && preview.status !== "confirmed" && preview.plan.isIncrease && (
            <div className="mt-2 text-xs text-muted">
              <p>Already holding {preview.plan.existingLots} lot{preview.plan.existingLots === 1 ? "" : "s"} at {legLabel(preview.plan.shortLeg)}</p>
              {preview.plan.longLeg && <p>Spread w/ {legLabel(preview.plan.longLeg)}</p>}
              <p>Existing avg entry {fmt(preview.plan.existingEntryPremium)} → Current {fmt(preview.plan.currentPremium)}</p>
              <p>Expiry {preview.plan.expiry} · underlying {fmt(preview.plan.underlyingPrice)} · lot size {preview.plan.lotSize}</p>
              <label className="mt-2 block">
                Lots to add
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  step="1"
                  value={preview.lotsText}
                  onChange={(e) => setPreview(preview && { ...preview, lotsText: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-border bg-surface2 p-2 text-sm text-foreground"
                />
              </label>
            </div>
          )}
          {preview.plan && preview.status !== "confirmed" && !preview.plan.isIncrease && (
            <div className="mt-2 text-xs text-muted">
              <p>
                Expiry {preview.plan.expiry} ({preview.plan.tradingSessionsUntilExpiry} sessions left
                {preview.plan.usedNextMonth ? ", rolled to next month" : ""})
              </p>
              <p>Underlying {fmt(preview.plan.underlyingPrice)}</p>
              {preview.mode === "buy" ? (
                <p>
                  Buy {legLabel(preview.plan.shortLeg)} @ {fmt(preview.plan.shortLeg.premium)} · lot size{" "}
                  {preview.plan.shortLeg.lotSize}
                </p>
              ) : (
                preview.plan.longLeg && (
                  <p>
                    Sell {legLabel(preview.plan.shortLeg)} @ {fmt(preview.plan.shortLeg.premium)} / Buy{" "}
                    {legLabel(preview.plan.longLeg)} @ {fmt(preview.plan.longLeg.premium)} · net credit{" "}
                    {fmt(preview.plan.entryPremium)} · lot size {preview.plan.shortLeg.lotSize}
                  </p>
                )
              )}
              <label className="mt-2 block">
                Lots
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  step="1"
                  value={preview.lotsText}
                  onChange={(e) => setPreview(preview && { ...preview, lotsText: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-border bg-surface2 p-2 text-sm text-foreground"
                />
              </label>
            </div>
          )}
          <div className="mt-3 flex gap-2">
            {preview.status !== "confirmed" && (
              <button
                onClick={confirmTrade}
                disabled={preview.status !== "ready" && preview.status !== "error"}
                className="flex-1 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-black disabled:opacity-50"
              >
                {preview.status === "confirming" ? "Submitting…" : "Confirm"}
              </button>
            )}
            <button
              onClick={() => setPreview(null)}
              className="flex-1 rounded-lg border border-border px-3 py-2 text-xs font-medium"
            >
              {preview.status === "confirmed" ? "Done" : "Cancel"}
            </button>
          </div>
        </div>
      )}

      <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border">
        {sorted.length === 0 && <li className="bg-surface px-4 py-4 text-center text-xs text-muted">No signals right now.</li>}
        {sorted.map((s) => (
          <li key={`${s.symbol}-${s.direction}`} className="bg-surface px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="font-medium">{s.symbol}</span>
              <span className={`text-[10px] font-semibold uppercase ${s.direction === "short" ? "text-danger" : "text-accent"}`}>
                {signalLabel(s)}
              </span>
            </div>
            <div className="mt-1 text-[11px] text-muted">
              Entry {fmt(s.entryPrice)} → Target {fmt(s.targetSma.value)} ({targetGapPercent(s).toFixed(1)}%)
            </div>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => openPreview(s.symbol, s.direction, "buy")}
                className="flex-1 rounded-lg border border-border bg-surface2 px-3 py-1.5 text-xs font-medium"
              >
                Buy option
              </button>
              <button
                onClick={() => openPreview(s.symbol, s.direction, "sell")}
                className="flex-1 rounded-lg border border-border bg-surface2 px-3 py-1.5 text-xs font-medium"
              >
                Sell spread
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
