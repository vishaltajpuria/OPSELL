"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { StockLiquidity } from "@/lib/liquidity";
import type { IndexQuote } from "@/lib/indices";

function fmtPrice(n: number | null) {
  if (n === null) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function fmtCompact(n: number | null) {
  if (n === null) return "—";
  return n.toLocaleString("en-IN", { notation: "compact", maximumFractionDigits: 1 });
}

function ChangeBadge({ changePercent }: { changePercent: number | null }) {
  if (changePercent === null) return <span className="text-xs text-muted">—</span>;
  const up = changePercent >= 0;
  return (
    <span className={`text-xs font-medium ${up ? "text-accent" : "text-danger"}`}>
      {up ? "+" : ""}
      {changePercent.toFixed(2)}%
    </span>
  );
}

function StockRow({ stock }: { stock: StockLiquidity }) {
  return (
    <Link
      href={`/stocks/${encodeURIComponent(stock.symbol)}`}
      className="flex items-center justify-between bg-surface px-4 py-3.5 active:bg-surface2"
    >
      <div>
        <div className="font-medium">{stock.symbol}</div>
        <div className="mt-0.5 text-[11px] text-muted">
          {stock.futuresOI !== null && stock.futuresVolume !== null
            ? `OI ${fmtCompact(stock.futuresOI)} · Vol ${fmtCompact(stock.futuresVolume)}`
            : "No futures data"}
        </div>
      </div>
      <div className="text-right">
        <div className="font-medium tabular-nums">{fmtPrice(stock.ltp)}</div>
        <ChangeBadge changePercent={stock.changePercent} />
      </div>
    </Link>
  );
}

function IndexRow({ index }: { index: IndexQuote }) {
  return (
    <div className="flex items-center justify-between bg-surface px-4 py-3.5">
      <div className="font-medium">{index.label}</div>
      <div className="text-right">
        <div className="font-medium tabular-nums">{fmtPrice(index.ltp)}</div>
        <ChangeBadge changePercent={index.changePercent} />
      </div>
    </div>
  );
}

type Tab = "liquid" | "illiquid" | "indices";

export default function StockScanner({
  liquidStocks,
  illiquidStocks,
  indices,
}: {
  liquidStocks: StockLiquidity[];
  illiquidStocks: StockLiquidity[];
  indices: IndexQuote[];
}) {
  const [tab, setTab] = useState<Tab>("liquid");
  const [query, setQuery] = useState("");

  const activeStocks = tab === "liquid" ? liquidStocks : tab === "illiquid" ? illiquidStocks : [];

  const filteredStocks = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return activeStocks;
    return activeStocks.filter((s) => s.symbol.includes(q));
  }, [activeStocks, query]);

  const filteredIndices = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return indices;
    return indices.filter((i) => i.key.includes(q) || i.label.toUpperCase().includes(q));
  }, [indices, query]);

  return (
    <div className="px-4 pt-4">
      <div className="flex rounded-xl border border-border bg-surface p-1">
        {(
          [
            ["liquid", `Liquid (${liquidStocks.length})`],
            ["illiquid", `Illiquid (${illiquidStocks.length})`],
            ["indices", `Indices (${indices.length})`],
          ] as [Tab, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`flex-1 rounded-lg py-2 text-xs font-medium ${
              tab === value ? "bg-accent text-black" : "text-muted"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab !== "indices" && (
        <p className="mt-3 text-[11px] leading-snug text-muted">
          Ranked by today&apos;s near-month futures open interest + volume (percentile blend),
          split at the median. Stocks with no futures data are Illiquid by default.
        </p>
      )}

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search…"
        className="mt-3 w-full rounded-xl border border-border bg-surface px-4 py-3 text-base outline-none placeholder:text-muted focus:border-accent"
        autoCapitalize="characters"
      />

      <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border">
        {tab === "indices"
          ? filteredIndices.map((i) => (
              <li key={i.key}>
                <IndexRow index={i} />
              </li>
            ))
          : filteredStocks.map((s) => (
              <li key={s.symbol}>
                <StockRow stock={s} />
              </li>
            ))}
        {(tab === "indices" ? filteredIndices.length : filteredStocks.length) === 0 && (
          <li className="bg-surface px-4 py-6 text-center text-sm text-muted">No matches.</li>
        )}
      </ul>
    </div>
  );
}
