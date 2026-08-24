"use client";

import { useCallback, useEffect, useState } from "react";

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

type PaperTrade = {
  id: string;
  symbol: string;
  direction: "short" | "long";
  mode: "buy" | "sell";
  expiry: string;
  tradingSessionsUntilExpiryAtEntry: number;
  shortLeg: PaperTradeLeg;
  longLeg: PaperTradeLeg | null;
  lots: number;
  lotSize: number;
  entryAt: string;
  entryUnderlyingPrice: number;
  entryPremium: number;
  status: "open" | "closed";
  exitAt: string | null;
  exitUnderlyingPrice: number | null;
  exitPremium: number | null;
  lastMarkPremium: number | null;
  lastMarkAt: string | null;
};

type TradePlanLeg = { tradingsymbol: string; strike: number; optionType: "CE" | "PE"; premium: number; lotSize: number };

type TradePlan = {
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

function fmt(n: number, digits = 2) {
  return n.toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
function signedFmt(n: number, digits = 2) {
  return `${n >= 0 ? "+" : ""}${fmt(n, digits)}`;
}

// Same sign convention as computePnlPerShare in lib/paperTrading.ts — not
// imported directly since that module pulls in server-only code (session
// cookies, fetch to Kite) that can't run in a client bundle.
function pnlPerShare(mode: "buy" | "sell", entryPremium: number, currentPremium: number): number {
  return mode === "buy" ? currentPremium - entryPremium : entryPremium - currentPremium;
}

function signalLabel(s: Pick<StoredSignal, "direction" | "triggerSma">): string {
  const base = s.direction === "short" ? "Short" : "Long";
  const isSuper = s.triggerSma.period === 50 || s.triggerSma.period === 100;
  return isSuper ? `Super ${base}` : base;
}

function legLabel(leg: PaperTradeLeg | TradePlanLeg) {
  return `${leg.strike.toFixed(0)}${leg.optionType}`;
}

type Preview = {
  symbol: string;
  direction: "short" | "long";
  mode: "buy" | "sell";
  status: "loading" | "ready" | "confirming" | "error";
  plan: TradePlan | null;
  error: string | null;
  lotsText: string;
};

export default function PaperTradingBoard() {
  const [candidates, setCandidates] = useState<StoredSignal[]>([]);
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [runAt, setRunAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "refreshing">("loading");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    setLoadError(null);
    try {
      const res = await fetch("/api/papertrade");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load.");
      setCandidates(data.candidates);
      setTrades(data.trades);
      setRunAt(data.runAt);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatus("idle");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
      const res = await fetch("/api/papertrade/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: preview.symbol, direction: preview.direction, mode: preview.mode, lots }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to start the trade.");
      setTrades((prev) => [data.trade, ...prev]);
      setPreview(null);
    } catch (err) {
      setPreview({ ...preview, status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function refreshLive() {
    setStatus("refreshing");
    try {
      const res = await fetch("/api/papertrade/refresh", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to refresh live prices.");
      setTrades(data.trades);
      setRefreshedAt(data.refreshedAt);
      if (data.stale.length > 0) {
        setLoadError(`Couldn't get a live quote for ${data.stale.length} trade(s) — they still show their last known price.`);
      } else {
        setLoadError(null);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatus("idle");
    }
  }

  async function closeTrade(id: string) {
    setClosingId(id);
    try {
      const res = await fetch("/api/papertrade/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to close the trade.");
      setTrades((prev) => prev.map((t) => (t.id === id ? data.trade : t)));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setClosingId(null);
    }
  }

  const openTrades = trades.filter((t) => t.status === "open");
  const closedTrades = trades.filter((t) => t.status === "closed");

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted">
          {runAt
            ? `Candidates from the ${new Date(runAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} IST run`
            : "No candidates yet — run the Strategy scan first."}
        </p>
        <button
          onClick={refreshLive}
          disabled={status === "refreshing" || openTrades.length === 0}
          className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-black disabled:opacity-50"
        >
          {status === "refreshing" ? "Updating…" : "Live"}
        </button>
      </div>
      {refreshedAt && (
        <p className="mt-1 text-[10px] text-muted">
          Prices as of {new Date(refreshedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST
        </p>
      )}
      {loadError && <p className="mt-2 text-xs text-danger">{loadError}</p>}

      {preview && (
        <div className="mt-3 rounded-xl border border-accent/50 bg-accent/5 p-3">
          <p className="text-sm font-semibold">
            {preview.symbol} · {preview.mode === "buy" ? "Buy" : "Sell"} · {preview.direction}
          </p>
          {preview.status === "loading" && <p className="mt-2 text-xs text-muted">Fetching live option chain…</p>}
          {preview.status === "error" && <p className="mt-2 text-xs text-danger">{preview.error}</p>}
          {preview.plan && (
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
            <button
              onClick={confirmTrade}
              disabled={preview.status !== "ready" && preview.status !== "error"}
              className="flex-1 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-black disabled:opacity-50"
            >
              {preview.status === "confirming" ? "Starting…" : "Confirm"}
            </button>
            <button
              onClick={() => setPreview(null)}
              className="flex-1 rounded-lg border border-border px-3 py-2 text-xs font-medium"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <h2 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Candidates ({candidates.length})</h2>
      {status === "loading" && <p className="mt-2 text-xs text-muted">Loading…</p>}
      {status !== "loading" && candidates.length === 0 && <p className="mt-2 text-xs text-muted">No signals right now.</p>}
      <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
        {candidates.map((s) => (
          <li key={`${s.symbol}-${s.direction}`} className="bg-surface px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="font-medium">{s.symbol}</span>
              <span className={`text-[10px] font-semibold uppercase ${s.direction === "short" ? "text-danger" : "text-accent"}`}>
                {signalLabel(s)}
              </span>
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

      <h2 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Open ({openTrades.length})</h2>
      <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
        {openTrades.length === 0 && <li className="bg-surface px-4 py-4 text-center text-xs text-muted">No open paper trades.</li>}
        {openTrades.map((t) => {
          const currentPremium = t.lastMarkPremium ?? t.entryPremium;
          const perShare = pnlPerShare(t.mode, t.entryPremium, currentPremium);
          const total = perShare * t.lots * t.lotSize;
          return (
            <li key={t.id} className="bg-surface px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">
                  {t.symbol} <span className="text-[10px] font-normal text-muted">{t.mode === "buy" ? "Buy" : "Sell"} {legLabel(t.shortLeg)}</span>
                </span>
                <span className={`text-sm font-semibold ${total >= 0 ? "text-accent" : "text-danger"}`}>{signedFmt(total, 0)}</span>
              </div>
              <div className="mt-1 text-[11px] text-muted">
                {t.mode === "sell" && t.longLeg && `Spread w/ ${legLabel(t.longLeg)} · `}
                Entry {fmt(t.entryPremium)} → Now {fmt(currentPremium)} · {t.lots} lot{t.lots === 1 ? "" : "s"} × {t.lotSize} · exp {t.expiry}
              </div>
              <button
                onClick={() => closeTrade(t.id)}
                disabled={closingId === t.id}
                className="mt-2 w-full rounded-lg border border-danger/40 px-3 py-1.5 text-xs font-medium text-danger disabled:opacity-50"
              >
                {closingId === t.id ? "Closing…" : "Close"}
              </button>
            </li>
          );
        })}
      </ul>

      {closedTrades.length > 0 && (
        <>
          <h2 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Closed ({closedTrades.length})</h2>
          <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {closedTrades.map((t) => {
              const perShare = pnlPerShare(t.mode, t.entryPremium, t.exitPremium ?? t.entryPremium);
              const total = perShare * t.lots * t.lotSize;
              return (
                <li key={t.id} className="bg-surface px-4 py-3">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">
                      {t.symbol} <span className="text-[10px] font-normal text-muted">{t.mode === "buy" ? "Buy" : "Sell"} {legLabel(t.shortLeg)}</span>
                    </span>
                    <span className={`text-sm font-semibold ${total >= 0 ? "text-accent" : "text-danger"}`}>{signedFmt(total, 0)}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-muted">
                    Entry {fmt(t.entryPremium)} → Exit {fmt(t.exitPremium ?? 0)} · {t.lots} lot{t.lots === 1 ? "" : "s"} × {t.lotSize}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
