"use client";

import { useState } from "react";

type FnoStock = { name: string; lotSize: number; expiries: string[] };
type IndexOption = { key: string; label: string };

type SymbolOption = { symbol: string; label: string };

type SymbolListState =
  | { status: "idle" | "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; options: SymbolOption[] };

const MAX_RESULTS = 8;

/**
 * Lets you open a paper trade on ANY F&O stock or index, not just today's
 * strategy candidates — the strategy's own signal list is unaffected by
 * this, it's a separate manual entry point into the same preview/confirm
 * flow (onTrade is PaperTradeCandidates' existing openPreview), so
 * whatever you pick here gets the same live pricing, strike picker
 * ("Choose strike(s) myself"), and confirm-locks-what-you-previewed
 * behavior as a strategy candidate does.
 *
 * There's no algorithmic signal for an arbitrary scrip, so "direction"
 * (Long/Short) is chosen directly here instead of coming from a crossover
 * — it feeds the exact same buy/sell option-type mapping either way (Long
 * buys a call or sells a put spread, Short buys a put or sells a call
 * spread — see buildTradePlan in lib/paperTrading.ts).
 */
export default function ManualTradePanel({
  onTrade,
}: {
  onTrade: (symbol: string, direction: "short" | "long", mode: "buy" | "sell") => void;
}) {
  const [symbolList, setSymbolList] = useState<SymbolListState>({ status: "idle" });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SymbolOption | null>(null);
  const [direction, setDirection] = useState<"long" | "short">("long");

  async function ensureSymbolList() {
    if (symbolList.status === "ready" || symbolList.status === "loading") return;
    setSymbolList({ status: "loading" });
    try {
      const res = await fetch("/api/instruments");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load the symbol list.");
      const options: SymbolOption[] = [
        ...(data.indices as IndexOption[]).map((i) => ({ symbol: i.key, label: i.label })),
        ...(data.stocks as FnoStock[]).map((s) => ({ symbol: s.name, label: s.name })),
      ];
      setSymbolList({ status: "ready", options });
    } catch (err) {
      setSymbolList({ status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }

  const matches =
    symbolList.status === "ready" && query.trim().length > 0
      ? symbolList.options.filter((o) => o.label.toUpperCase().includes(query.trim().toUpperCase())).slice(0, MAX_RESULTS)
      : [];

  if (selected) {
    return (
      <div className="mt-3 rounded-xl border border-border bg-surface p-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">{selected.label}</p>
          <button
            onClick={() => {
              setSelected(null);
              setQuery("");
            }}
            className="text-[11px] text-muted underline decoration-dotted"
          >
            Change
          </button>
        </div>
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => setDirection("long")}
            className={`flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium ${
              direction === "long" ? "border-accent bg-accent/10 text-accent" : "border-border bg-surface2"
            }`}
          >
            Long
          </button>
          <button
            onClick={() => setDirection("short")}
            className={`flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium ${
              direction === "short" ? "border-danger bg-danger/10 text-danger" : "border-border bg-surface2"
            }`}
          >
            Short
          </button>
        </div>
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => onTrade(selected.symbol, direction, "buy")}
            className="flex-1 rounded-lg border border-border bg-surface2 px-3 py-1.5 text-xs font-medium"
          >
            Buy option
          </button>
          <button
            onClick={() => onTrade(selected.symbol, direction, "sell")}
            className="flex-1 rounded-lg border border-border bg-surface2 px-3 py-1.5 text-xs font-medium"
          >
            Sell spread
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-xl border border-border bg-surface p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">Trade any scrip</p>
      <input
        type="text"
        inputMode="search"
        placeholder="Search a stock or index…"
        value={query}
        onFocus={ensureSymbolList}
        onChange={(e) => setQuery(e.target.value)}
        className="mt-2 w-full rounded-lg border border-border bg-surface2 p-2 text-sm text-foreground"
      />
      {symbolList.status === "loading" && <p className="mt-2 text-[11px] text-muted">Loading symbol list…</p>}
      {symbolList.status === "error" && <p className="mt-2 text-[11px] text-danger">{symbolList.error}</p>}
      {query.trim().length > 0 && symbolList.status === "ready" && (
        <ul className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">
          {matches.length === 0 && <li className="bg-surface2 px-3 py-2 text-[11px] text-muted">No matches.</li>}
          {matches.map((o) => (
            <li key={o.symbol}>
              <button
                onClick={() => {
                  setSelected(o);
                  setQuery("");
                }}
                className="w-full bg-surface2 px-3 py-2 text-left text-xs"
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
