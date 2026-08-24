"use client";

import { useCallback, useEffect, useState } from "react";

type PaperTradeLeg = { tradingsymbol: string; strike: number; optionType: "CE" | "PE" };

type ClosedLot = {
  lots: number;
  exitPremium: number;
  exitUnderlyingPrice: number;
  closedAt: string;
  capitalReleased: number | null;
  pnl: number;
};

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
  closedLots: ClosedLot[];
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

function DirectionBadge({ direction }: { direction: "short" | "long" }) {
  return (
    <span className={`text-[10px] font-semibold uppercase ${direction === "short" ? "text-danger" : "text-accent"}`}>
      {direction}
    </span>
  );
}

/**
 * A credit spread's max profit is the net credit collected (entryPremium),
 * realized if both legs expire worthless with the underlying away from the
 * short strike; max loss is capped at (strike width − that credit), hit
 * once the underlying moves past both strikes — the whole reason a spread
 * is bought against the naked short in the first place. Only meaningful
 * for a sell-mode position with a protective long leg; naked buying has no
 * such cap to show here (loss is capped at the premium paid, already shown
 * as the position's capital; profit is uncapped).
 */
function spreadMaxProfitLoss(
  t: Pick<PaperTrade, "mode" | "shortLeg" | "longLeg" | "entryPremium" | "lots" | "lotSize">
): { maxProfit: number; maxLoss: number } | null {
  if (t.mode !== "sell" || !t.longLeg) return null;
  const width = Math.abs(t.longLeg.strike - t.shortLeg.strike);
  const scale = t.lots * t.lotSize;
  return { maxProfit: t.entryPremium * scale, maxLoss: (width - t.entryPremium) * scale };
}

type Adjustment = {
  tradeId: string;
  action: "increase" | "decrease";
  lotsText: string;
  status: "idle" | "submitting";
  error: string | null;
};

export default function PaperTradePositions() {
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "refreshing">("loading");
  const [closingId, setClosingId] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [adjustment, setAdjustment] = useState<Adjustment | null>(null);
  const [merging, setMerging] = useState(false);

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

  async function mergeDuplicates() {
    setMerging(true);
    setError(null);
    try {
      const res = await fetch("/api/papertrade/merge", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to merge duplicate positions.");
      setTrades(data.trades);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMerging(false);
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

  async function closeTrade(id: string, lots?: number) {
    setClosingId(id);
    try {
      const res = await fetch("/api/papertrade/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lots ? { id, lots } : { id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to close the trade.");
      setTrades((prev) => prev.map((t) => (t.id === id ? data.trade : t)));
      setAdjustment(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setClosingId(null);
    }
  }

  async function submitAdjustment(trade: PaperTrade) {
    if (!adjustment) return;
    const lots = Number(adjustment.lotsText);
    if (!Number.isInteger(lots) || lots <= 0) {
      setAdjustment({ ...adjustment, error: "Lots must be a positive whole number." });
      return;
    }
    if (adjustment.action === "decrease" && lots > trade.lots) {
      setAdjustment({ ...adjustment, error: `Only ${trade.lots} lot${trade.lots === 1 ? "" : "s"} open.` });
      return;
    }
    setAdjustment({ ...adjustment, status: "submitting" });
    try {
      if (adjustment.action === "increase") {
        const res = await fetch("/api/papertrade/increase", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: trade.symbol, mode: trade.mode, lots }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to increase the position.");
        setTrades((prev) => prev.map((t) => (t.id === trade.id ? data.trade : t)));
      } else {
        const res = await fetch("/api/papertrade/close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: trade.id, lots }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to reduce the position.");
        setTrades((prev) => prev.map((t) => (t.id === trade.id ? data.trade : t)));
      }
      setAdjustment(null);
    } catch (err) {
      setAdjustment({ ...adjustment, status: "idle", error: err instanceof Error ? err.message : String(err) });
    }
  }

  const openTrades = trades.filter((t) => t.status === "open" && t.lots > 0);
  const closedEvents = trades
    .flatMap((t) => t.closedLots.map((lot) => ({ trade: t, lot })))
    .sort((a, b) => b.lot.closedAt.localeCompare(a.lot.closedAt));
  // typeof check, not !== null: a trade opened before capitalRequired
  // existed has no such field in storage at all (undefined at runtime,
  // even though the type says it's always present) — treating that the
  // same as "known" crashed the page trying to format it as a number.
  const knownCapital = openTrades.filter((t) => typeof t.capitalRequired === "number");
  const totalCapital = knownCapital.reduce((sum, t) => sum + (t.capitalRequired as number), 0);
  const unknownCapitalCount = openTrades.length - knownCapital.length;

  // Same-contract duplicates — e.g. the same symbol/mode/strike opened
  // twice — surfaced here purely to decide whether to show the merge
  // banner; the actual merge math runs server-side (mergeOpenTradeGroup in
  // lib/paperTrading.ts) since it needs a fresh margin lookup for the
  // combined size.
  const duplicateKeys = new Set<string>();
  const seenKeys = new Set<string>();
  for (const t of openTrades) {
    const key = [t.symbol, t.mode, t.shortLeg.tradingsymbol, t.longLeg?.tradingsymbol ?? ""].join("|");
    if (seenKeys.has(key)) duplicateKeys.add(key);
    seenKeys.add(key);
  }

  return (
    <div>
      {duplicateKeys.size > 0 && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-accent/40 bg-accent/5 p-3">
          <p className="text-xs">
            {duplicateKeys.size} position{duplicateKeys.size === 1 ? "" : "s"} split across duplicate entries — same
            strike, showing separately.
          </p>
          <button
            onClick={mergeDuplicates}
            disabled={merging}
            className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-black disabled:opacity-50"
          >
            {merging ? "Merging…" : "Merge"}
          </button>
        </div>
      )}

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
          {status === "loading" ? "Loading…" : `${openTrades.length} open · ${closedEvents.length} closed`}
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
          const isAdjustingThis = adjustment?.tradeId === t.id;
          const maxPL = spreadMaxProfitLoss(t);
          return (
            <li key={t.id} className="bg-surface px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">
                  {t.symbol} <DirectionBadge direction={t.direction} />{" "}
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
              {maxPL && (
                <div className="mt-0.5 text-[11px]">
                  <span className="text-muted">Max profit </span>
                  <span className="font-medium text-accent">₹{fmt(maxPL.maxProfit, 0)}</span>
                  <span className="text-muted"> · Max loss </span>
                  <span className="font-medium text-danger">₹{fmt(maxPL.maxLoss, 0)}</span>
                </div>
              )}

              {isAdjustingThis && adjustment && (
                <div className="mt-2 rounded-lg border border-accent/40 bg-accent/5 p-2.5">
                  <p className="text-[11px] font-medium">
                    {adjustment.action === "increase" ? "Add lots" : "Reduce lots"} — {t.symbol}
                  </p>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="1"
                    step="1"
                    max={adjustment.action === "decrease" ? t.lots : undefined}
                    value={adjustment.lotsText}
                    onChange={(e) => setAdjustment({ ...adjustment, lotsText: e.target.value, error: null })}
                    className="mt-1.5 w-full rounded-lg border border-border bg-surface2 p-2 text-sm text-foreground"
                  />
                  {adjustment.error && <p className="mt-1 text-[10px] text-danger">{adjustment.error}</p>}
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => submitAdjustment(t)}
                      disabled={adjustment.status === "submitting"}
                      className="flex-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-black disabled:opacity-50"
                    >
                      {adjustment.status === "submitting" ? "Working…" : "Confirm"}
                    </button>
                    <button
                      onClick={() => setAdjustment(null)}
                      className="flex-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {!isAdjustingThis && (
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => setAdjustment({ tradeId: t.id, action: "increase", lotsText: "1", status: "idle", error: null })}
                    className="flex-1 rounded-lg border border-border bg-surface2 px-3 py-1.5 text-xs font-medium"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => setAdjustment({ tradeId: t.id, action: "decrease", lotsText: "1", status: "idle", error: null })}
                    className="flex-1 rounded-lg border border-border bg-surface2 px-3 py-1.5 text-xs font-medium"
                    disabled={t.lots <= 1}
                    title={t.lots <= 1 ? "Only 1 lot open — use Close instead" : undefined}
                  >
                    Reduce
                  </button>
                  <button
                    onClick={() => closeTrade(t.id)}
                    disabled={closingId === t.id}
                    className="flex-1 rounded-lg border border-danger/40 px-3 py-1.5 text-xs font-medium text-danger disabled:opacity-50"
                  >
                    {closingId === t.id ? "Closing…" : "Close"}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {closedEvents.length > 0 && (
        <>
          <h2 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Closed ({closedEvents.length})</h2>
          <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {closedEvents.map(({ trade: t, lot }, i) => (
              <li key={`${t.id}-${i}`} className="bg-surface px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    {t.symbol} <DirectionBadge direction={t.direction} />{" "}
                    <span className="text-[10px] font-normal text-muted">
                      {t.mode === "buy" ? "Buy" : "Sell"} {legLabel(t.shortLeg)}
                    </span>
                  </span>
                  <span className={`text-sm font-semibold ${lot.pnl >= 0 ? "text-accent" : "text-danger"}`}>{signedFmt(lot.pnl, 0)}</span>
                </div>
                <div className="mt-1 text-[11px] text-muted">
                  Entry {fmt(t.entryPremium)} → Exit {fmt(lot.exitPremium)} · {lot.lots} lot{lot.lots === 1 ? "" : "s"} × {t.lotSize} ·{" "}
                  {new Date(lot.closedAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
