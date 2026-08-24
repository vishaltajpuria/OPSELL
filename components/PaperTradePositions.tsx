"use client";

import { useCallback, useEffect, useState } from "react";

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
  capitalRequired: number | null;
  status: "open" | "closed";
  exitAt: string | null;
  exitUnderlyingPrice: number | null;
  exitPremium: number | null;
  lastMarkPremium: number | null;
  lastMarkAt: string | null;
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

function legLabel(leg: PaperTradeLeg) {
  return `${leg.strike.toFixed(0)}${leg.optionType}`;
}

export default function PaperTradePositions() {
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "refreshing">("loading");
  const [closingId, setClosingId] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/papertrade");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load.");
      setTrades(data.trades);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatus("idle");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function refreshLive() {
    setStatus("refreshing");
    try {
      const res = await fetch("/api/papertrade/refresh", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to refresh live prices.");
      setTrades(data.trades);
      setRefreshedAt(data.refreshedAt);
      setError(
        data.stale.length > 0
          ? `Couldn't get a live quote for ${data.stale.length} trade(s) — they still show their last known price.`
          : null
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setClosingId(null);
    }
  }

  const openTrades = trades.filter((t) => t.status === "open");
  const closedTrades = trades.filter((t) => t.status === "closed");
  // typeof check, not !== null: a trade opened before capitalRequired
  // existed has no such field in storage at all (undefined at runtime,
  // even though the type says it's always present) — treating that the
  // same as "known" crashed the page trying to format it as a number.
  const knownCapital = openTrades.filter((t) => typeof t.capitalRequired === "number");
  const totalCapital = knownCapital.reduce((sum, t) => sum + (t.capitalRequired as number), 0);
  const unknownCapitalCount = openTrades.length - knownCapital.length;

  return (
    <div>
      {openTrades.length > 0 && (
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="text-xs text-muted">Total capital deployed</p>
          <p className="mt-1 text-2xl font-semibold">₹{fmt(totalCapital, 0)}</p>
          {unknownCapitalCount > 0 && (
            <p className="mt-1 text-[10px] text-danger">
              {unknownCapitalCount} open position{unknownCapitalCount === 1 ? "" : "s"} missing a margin figure — not included above.
            </p>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-muted">
          {status === "loading" ? "Loading…" : `${openTrades.length} open · ${closedTrades.length} closed`}
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
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      <h2 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">Open ({openTrades.length})</h2>
      <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
        {openTrades.length === 0 && status !== "loading" && (
          <li className="bg-surface px-4 py-4 text-center text-xs text-muted">
            No open paper trades — start one from the Trade tab.
          </li>
        )}
        {openTrades.map((t) => {
          const currentPremium = t.lastMarkPremium ?? t.entryPremium;
          const perShare = pnlPerShare(t.mode, t.entryPremium, currentPremium);
          const total = perShare * t.lots * t.lotSize;
          return (
            <li key={t.id} className="bg-surface px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">
                  {t.symbol}{" "}
                  <span className="text-[10px] font-normal text-muted">
                    {t.mode === "buy" ? "Buy" : "Sell"} {legLabel(t.shortLeg)}
                  </span>
                </span>
                <span className={`text-sm font-semibold ${total >= 0 ? "text-accent" : "text-danger"}`}>{signedFmt(total, 0)}</span>
              </div>
              <div className="mt-1 text-[11px] text-muted">
                {t.mode === "sell" && t.longLeg && `Spread w/ ${legLabel(t.longLeg)} · `}
                Entry {fmt(t.entryPremium)} → Now {fmt(currentPremium)} · {t.lots} lot{t.lots === 1 ? "" : "s"} × {t.lotSize} · exp{" "}
                {t.expiry}
              </div>
              <div className="mt-0.5 text-[11px] text-muted">
                Capital {typeof t.capitalRequired === "number" ? `₹${fmt(t.capitalRequired, 0)}` : "unknown (margin lookup failed)"}
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
                      {t.symbol}{" "}
                      <span className="text-[10px] font-normal text-muted">
                        {t.mode === "buy" ? "Buy" : "Sell"} {legLabel(t.shortLeg)}
                      </span>
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
