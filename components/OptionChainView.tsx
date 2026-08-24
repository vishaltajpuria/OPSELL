"use client";

import { useEffect, useState } from "react";
import type { OptionChain } from "@/lib/optionChain";

function fmt(n: number | null | undefined) {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

export default function OptionChainView({
  symbol,
  expiries,
  initialChain,
}: {
  symbol: string;
  expiries: string[];
  initialChain: OptionChain;
}) {
  const [expiry, setExpiry] = useState(initialChain.expiry);
  const [chain, setChain] = useState(initialChain);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (expiry === initialChain.expiry) {
      setChain(initialChain);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/quote?symbol=${encodeURIComponent(symbol)}&expiry=${expiry}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) setError(data.error);
        else setChain(data);
      })
      .catch(() => !cancelled && setError("Failed to load option chain."))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [expiry, symbol, initialChain]);

  const spot = chain.spotPrice;
  const atmStrike = spot
    ? chain.rows.reduce((best, r) => (Math.abs(r.strike - spot) < Math.abs(best - spot) ? r.strike : best), chain.rows[0]?.strike ?? 0)
    : null;

  return (
    <div className="px-4 pb-4">
      <div className="flex items-center justify-between gap-3 pt-3">
        <div>
          <h1 className="text-xl font-semibold">{symbol}</h1>
          <p className="text-sm text-muted">Spot {spot ? `₹${fmt(spot)}` : "—"}</p>
        </div>
        <select
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
        >
          {expiries.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</p>
      )}

      <div className="mt-3 overflow-hidden rounded-xl border border-border">
        <div className="grid grid-cols-7 bg-surface2 px-2 py-2 text-[11px] font-medium text-muted">
          <span className="col-span-2 text-right">Call OI</span>
          <span className="text-right">Call Mid</span>
          <span className="text-center">Strike</span>
          <span className="text-left">Put Mid</span>
          <span className="col-span-2 text-left">Put OI</span>
        </div>
        <div className={loading ? "opacity-50" : ""}>
          {chain.rows.map((row) => (
            <div
              key={row.strike}
              className={`grid grid-cols-7 border-t border-border px-2 py-2 text-xs ${
                row.strike === atmStrike ? "bg-accent/10" : "bg-surface"
              }`}
            >
              <span className="col-span-2 text-right text-muted">{fmt(row.call?.oi)}</span>
              <span className="text-right">
                <span className="font-medium">{fmt(row.call?.mid)}</span>
                {row.call && row.call.ltp !== row.call.mid && (
                  <span className="block text-[10px] text-muted">LTP {fmt(row.call.ltp)}</span>
                )}
              </span>
              <span className="text-center font-semibold">{row.strike}</span>
              <span className="text-left">
                <span className="font-medium">{fmt(row.put?.mid)}</span>
                {row.put && row.put.ltp !== row.put.mid && (
                  <span className="block text-[10px] text-muted">LTP {fmt(row.put.ltp)}</span>
                )}
              </span>
              <span className="col-span-2 text-left text-muted">{fmt(row.put?.oi)}</span>
            </div>
          ))}
          {chain.rows.length === 0 && !loading && (
            <p className="bg-surface px-4 py-6 text-center text-sm text-muted">No option chain data.</p>
          )}
        </div>
      </div>
    </div>
  );
}
