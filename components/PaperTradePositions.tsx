"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

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
  todayPnl: number | null;
  currentUnderlyingPrice: number | null;
  underlyingChangeValue: number | null;
  underlyingChangePercent: number | null;
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
  // Set whenever any call comes back 401 — Zerodha invalidates every
  // access token once a day regardless of when it was issued, so this is
  // expected daily behavior (typically first noticed at market open), not
  // an error to just leave as inline red text: it calls for a specific
  // action (reconnect from Settings), so it gets its own banner.
  const [authExpired, setAuthExpired] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/papertrade");
      const data = await res.json();
      if (!res.ok) {
        setAuthExpired(res.status === 401);
        throw new Error(data.error ?? "Failed to load.");
      }
      setTrades(data.trades);
      setAuthExpired(false);
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
      if (!res.ok) {
        setAuthExpired(res.status === 401);
        throw new Error(data.error ?? "Failed to merge duplicate positions.");
      }
      setTrades(data.trades);
      setAuthExpired(false);
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
      if (!res.ok) {
        setAuthExpired(res.status === 401);
        throw new Error(data.error ?? "Failed to refresh live prices.");
      }
      setAuthExpired(false);
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
      if (!res.ok) {
        setAuthExpired(res.status === 401);
        throw new Error(data.error ?? "Failed to close the trade.");
      }
      setAuthExpired(false);
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
          body: JSON.stringify({ id: trade.id, lots }),
        });
        const data = await res.json();
        if (!res.ok) {
          setAuthExpired(res.status === 401);
          throw new Error(data.error ?? "Failed to increase the position.");
        }
        setAuthExpired(false);
        setTrades((prev) => prev.map((t) => (t.id === trade.id ? data.trade : t)));
      } else {
        const res = await fetch("/api/papertrade/close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: trade.id, lots }),
        });
        const data = await res.json();
        if (!res.ok) {
          setAuthExpired(res.status === 401);
          throw new Error(data.error ?? "Failed to reduce the position.");
        }
        setAuthExpired(false);
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

  // Today's P&L combines two kinds of events: the day's mark-to-market move
  // on every still-open position (todayPnl, refreshed by the Live button —
  // see computeTodayPnl in lib/paperTrading.ts) plus the full realized P&L
  // of anything actually closed (fully or partially) today, which needs no
  // live refresh since it's already fixed the moment it closed.
  const todayIso = new Date().toISOString().slice(0, 10);
  const knownTodayOpen = openTrades.filter((t) => typeof t.todayPnl === "number");
  const unknownTodayCount = openTrades.length - knownTodayOpen.length;
  const todayClosedEvents = closedEvents.filter((e) => e.lot.closedAt.slice(0, 10) === todayIso);
  const todayPnl =
    knownTodayOpen.reduce((sum, t) => sum + (t.todayPnl as number), 0) +
    todayClosedEvents.reduce((sum, e) => sum + e.lot.pnl, 0);
  const hasTodayActivity = knownTodayOpen.length > 0 || todayClosedEvents.length > 0;

  // Booked (closed) trades are grouped for display by exact contract — same
  // symbol, mode, and leg(s) (tradingsymbol already encodes strike,
  // optionType, and expiry) — so a position closed in several tranches, or
  // reopened later at the identical strike, reads as one combined P&L
  // instead of a separate line per close event. A different strike (or a
  // different expiry at the same strike) is a genuinely different contract
  // and stays its own group. Entry/exit premiums shown are lots-weighted
  // averages across the group's events, since each event can carry a
  // different entry (if the position was topped up between closes) and
  // exit (closed at different times/prices).
  type ClosedGroup = {
    key: string;
    symbol: string;
    direction: "short" | "long";
    mode: "buy" | "sell";
    shortLeg: PaperTradeLeg;
    longLeg: PaperTradeLeg | null;
    lotSize: number;
    totalLots: number;
    totalPnl: number;
    entryWeighted: number;
    exitWeighted: number;
    eventCount: number;
    lastClosedAt: string;
  };
  const closedGroupMap = new Map<string, ClosedGroup>();
  for (const { trade: t, lot } of closedEvents) {
    const key = [t.symbol, t.mode, t.shortLeg.tradingsymbol, t.longLeg?.tradingsymbol ?? ""].join("|");
    const g = closedGroupMap.get(key);
    if (g) {
      g.totalLots += lot.lots;
      g.totalPnl += lot.pnl;
      g.entryWeighted += t.entryPremium * lot.lots;
      g.exitWeighted += lot.exitPremium * lot.lots;
      g.eventCount += 1;
      if (lot.closedAt > g.lastClosedAt) g.lastClosedAt = lot.closedAt;
    } else {
      closedGroupMap.set(key, {
        key,
        symbol: t.symbol,
        direction: t.direction,
        mode: t.mode,
        shortLeg: t.shortLeg,
        longLeg: t.longLeg,
        lotSize: t.lotSize,
        totalLots: lot.lots,
        totalPnl: lot.pnl,
        entryWeighted: t.entryPremium * lot.lots,
        exitWeighted: lot.exitPremium * lot.lots,
        eventCount: 1,
        lastClosedAt: lot.closedAt,
      });
    }
  }
  const closedGroups = Array.from(closedGroupMap.values()).sort((a, b) => b.lastClosedAt.localeCompare(a.lastClosedAt));

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
      {authExpired && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-danger/40 bg-danger/10 p-3">
          <p className="text-xs text-danger">
            Your Zerodha session has expired for the day — reconnect to keep going.
          </p>
          <Link
            href="/settings"
            className="shrink-0 rounded-lg bg-danger px-3 py-1.5 text-xs font-medium text-white"
          >
            Reconnect
          </Link>
        </div>
      )}

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

      {(openTrades.length > 0 || todayClosedEvents.length > 0) && (
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="text-xs text-muted">Today&apos;s P&amp;L</p>
          <p className={`mt-1 text-2xl font-semibold ${todayPnl >= 0 ? "text-accent" : "text-danger"}`}>
            {hasTodayActivity ? `₹${signedFmt(todayPnl, 0)}` : "—"}
          </p>
          {unknownTodayCount > 0 && (
            <p className="mt-1 text-[10px] text-danger">
              {unknownTodayCount} open position{unknownTodayCount === 1 ? "" : "s"} not refreshed yet today — hit{" "}
              <span className="font-medium">Live</span> to include {unknownTodayCount === 1 ? "it" : "them"}.
            </p>
          )}
        </div>
      )}

      {openTrades.length > 0 && (
        <div className="mt-3 rounded-xl border border-border bg-surface p-4">
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
      {error && !authExpired && <p className="mt-2 text-xs text-danger">{error}</p>}

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
              <div className="mt-0.5 text-[11px]">
                {typeof t.currentUnderlyingPrice === "number" ? (
                  <>
                    <span className="font-medium">₹{fmt(t.currentUnderlyingPrice)}</span>
                    {typeof t.underlyingChangeValue === "number" && typeof t.underlyingChangePercent === "number" && (
                      <span className={`ml-1.5 font-medium ${t.underlyingChangeValue >= 0 ? "text-accent" : "text-danger"}`}>
                        {t.underlyingChangeValue >= 0 ? "▲" : "▼"} {signedFmt(t.underlyingChangeValue)} (
                        {signedFmt(t.underlyingChangePercent, 1)}%)
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-muted">Underlying price — hit Live to refresh</span>
                )}
              </div>
              <div className="mt-1 text-[11px] text-muted">
                {t.mode === "sell" && t.longLeg && `Spread w/ ${legLabel(t.longLeg)} · `}
                Entry {fmt(t.entryPremium)} → Now {fmt(currentPremium)} · {t.lots} lot{t.lots === 1 ? "" : "s"} × {t.lotSize} · exp{" "}
                {t.expiry}
              </div>
              <div className="mt-0.5 text-[11px] text-muted">
                Capital {typeof t.capitalRequired === "number" ? `₹${fmt(t.capitalRequired, 0)}` : "unknown (margin lookup failed)"}
              </div>
              <div className="mt-0.5 text-[11px]">
                <span className="text-muted">Today </span>
                {typeof t.todayPnl === "number" ? (
                  <span className={`font-medium ${t.todayPnl >= 0 ? "text-accent" : "text-danger"}`}>
                    ₹{signedFmt(t.todayPnl, 0)}
                  </span>
                ) : (
                  <span className="text-muted">— hit Live to refresh</span>
                )}
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

      {closedGroups.length > 0 && (
        <>
          <h2 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Closed ({closedGroups.length})</h2>
          <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {closedGroups.map((g) => {
              const avgEntry = g.entryWeighted / g.totalLots;
              const avgExit = g.exitWeighted / g.totalLots;
              return (
                <li key={g.key} className="bg-surface px-4 py-3">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">
                      {g.symbol} <DirectionBadge direction={g.direction} />{" "}
                      <span className="text-[10px] font-normal text-muted">
                        {g.mode === "buy" ? "Buy" : "Sell"} {legLabel(g.shortLeg)}
                      </span>
                    </span>
                    <span className={`text-sm font-semibold ${g.totalPnl >= 0 ? "text-accent" : "text-danger"}`}>
                      {signedFmt(g.totalPnl, 0)}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-muted">
                    {g.mode === "sell" && g.longLeg && `Spread w/ ${legLabel(g.longLeg)} · `}
                    Entry {fmt(avgEntry)} → Exit {fmt(avgExit)} · {g.totalLots} lot{g.totalLots === 1 ? "" : "s"} × {g.lotSize}
                    {g.eventCount > 1 && ` · ${g.eventCount} closes`} ·{" "}
                    {new Date(g.lastClosedAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })}
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
