import type { PaperTrade } from "@/lib/kv";
import { computePnlPerShare } from "@/lib/paperTrading";

function tradePnl(trade: PaperTrade, premium: number): number {
  return computePnlPerShare(trade.mode, trade.entryPremium, premium) * trade.lots * trade.lotSize;
}

export type MonthlyPerformance = {
  month: string; // "YYYY-MM"
  tradeCount: number;
  wins: number;
  losses: number;
  totalPnl: number; // ₹, realized
  totalCapital: number; // ₹, sum of capitalRequired across trades closed this month that have one
  unknownCapitalCount: number; // trades closed this month with no capital figure — excluded from totalCapital/returnPercent
  returnPercent: number | null; // totalPnl / totalCapital * 100 — null if no trade closed this month has a known capital figure
};

export type PerformanceSummary = {
  monthly: MonthlyPerformance[]; // ascending by month
  cumulativePnl: { month: string; cumulative: number }[]; // running total realized P&L, same order as monthly
  overall: {
    tradeCount: number;
    wins: number;
    losses: number;
    totalPnl: number;
    totalCapital: number;
    unknownCapitalCount: number;
    returnPercent: number | null;
  };
  // Current mark-to-market of still-open positions — shown separately, not
  // folded into any month's return, since it isn't realized yet and can
  // still move either way before the trade is actually closed.
  openPositionsUnrealizedPnl: number;
};

/**
 * Monthly and cumulative performance from the paper-trade ledger, computed
 * fresh from whatever's currently stored — no separate cache to keep in
 * sync, so it's always up to date the moment a trade is closed.
 *
 * A trade's return counts toward the month it was CLOSED in (exitAt), not
 * opened — this is realized P&L, matching how "return on capital deployed"
 * is normally reported: only trades that have actually resolved. A month's
 * return % is the sum of P&L from every trade closed that month divided by
 * the sum of capital those trades required — a capital-weighted blend, not
 * a simple average of each trade's own % return, since a bigger position
 * should count for more. There's no fixed portfolio size assumed anywhere
 * (paper trading here has no defined starting capital) — "capital
 * deployed" is just whatever capitalRequired the trades closed that month
 * actually needed, summed.
 */
export function computePerformance(trades: PaperTrade[]): PerformanceSummary {
  const closed = trades.filter((t) => t.status === "closed" && t.exitAt !== null && t.exitPremium !== null);
  const open = trades.filter((t) => t.status === "open");

  const byMonth = new Map<string, PaperTrade[]>();
  for (const t of closed) {
    const month = (t.exitAt as string).slice(0, 7);
    const arr = byMonth.get(month) ?? [];
    arr.push(t);
    byMonth.set(month, arr);
  }

  const monthly: MonthlyPerformance[] = Array.from(byMonth.keys())
    .sort()
    .map((month) => {
      const ts = byMonth.get(month)!;
      let totalPnl = 0;
      let totalCapital = 0;
      let unknownCapitalCount = 0;
      let wins = 0;
      for (const t of ts) {
        const pnl = tradePnl(t, t.exitPremium as number);
        totalPnl += pnl;
        if (pnl > 0) wins++;
        if (typeof t.capitalRequired === "number") totalCapital += t.capitalRequired;
        else unknownCapitalCount++;
      }
      return {
        month,
        tradeCount: ts.length,
        wins,
        losses: ts.length - wins,
        totalPnl,
        totalCapital,
        unknownCapitalCount,
        returnPercent: totalCapital > 0 ? (totalPnl / totalCapital) * 100 : null,
      };
    });

  let running = 0;
  const cumulativePnl = monthly.map((m) => {
    running += m.totalPnl;
    return { month: m.month, cumulative: running };
  });

  const overallBase = monthly.reduce(
    (acc, m) => ({
      tradeCount: acc.tradeCount + m.tradeCount,
      wins: acc.wins + m.wins,
      losses: acc.losses + m.losses,
      totalPnl: acc.totalPnl + m.totalPnl,
      totalCapital: acc.totalCapital + m.totalCapital,
      unknownCapitalCount: acc.unknownCapitalCount + m.unknownCapitalCount,
    }),
    { tradeCount: 0, wins: 0, losses: 0, totalPnl: 0, totalCapital: 0, unknownCapitalCount: 0 }
  );

  const openPositionsUnrealizedPnl = open.reduce((sum, t) => sum + tradePnl(t, t.lastMarkPremium ?? t.entryPremium), 0);

  return {
    monthly,
    cumulativePnl,
    overall: { ...overallBase, returnPercent: overallBase.totalCapital > 0 ? (overallBase.totalPnl / overallBase.totalCapital) * 100 : null },
    openPositionsUnrealizedPnl,
  };
}
