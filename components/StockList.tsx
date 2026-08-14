"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { FnoStock } from "@/lib/instruments";

export default function StockList({ stocks }: { stocks: FnoStock[] }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return stocks;
    return stocks.filter((s) => s.name.includes(q));
  }, [stocks, query]);

  return (
    <div className="px-4 pt-4">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search F&O stocks…"
        className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-base outline-none placeholder:text-muted focus:border-accent"
        autoCapitalize="characters"
      />
      <p className="mt-3 mb-1 text-xs text-muted">{filtered.length} stocks</p>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
        {filtered.map((s) => (
          <li key={s.name}>
            <Link
              href={`/stocks/${encodeURIComponent(s.name)}`}
              className="flex items-center justify-between bg-surface px-4 py-3.5 active:bg-surface2"
            >
              <span className="font-medium">{s.name}</span>
              <span className="text-xs text-muted">Lot {s.lotSize}</span>
            </Link>
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="bg-surface px-4 py-6 text-center text-sm text-muted">No matches.</li>
        )}
      </ul>
    </div>
  );
}
