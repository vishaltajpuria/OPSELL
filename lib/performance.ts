import type { PaperTrade, ClosedLot } from "@/lib/kv";
import { computePnlPerShare } from "@/lib/paperTrading";

export type MonthlyPerformance = {
  month: string; // "YYYY-MM"
  tradeCount: number; // number of close EVENTS (a partial close counts on its own), not distinct positions
  wins: number;
  losses: number;
  totalPnl: number; // ₹, realized
  totalCapital: number; // ₹, sum of capitalReleased across events this month that have one
  unknownCapitalCount: number; // events this month with no capital figure — excluded from totalCapital/returnPercent
  returnPercent: number | null; // totalPnl / totalCapital * 100 — null if no event this month has a known capital figure
  returnOnBasePercent: number; // totalPnl / capitalBase * 100 — always known, since the base is a fixed setting
};

export type PerformanceSummary = {
  monthly: MonthlyPerformance[]; // ascending by month
  cumulativePnl: { month: string; cumulative: number }[]; // running total realized P&L, same order as monthly
  // capitalBase + cumulative realized P&L at the end of each month — a view
  // of the whole book's value growing over time, same order as monthly.
  portfolioValue: { month: string; value: number }[];
  overall: {
    tradeCount: number;
    wins: number;
    losses: number;
    totalPnl: number;
    totalCapital: number;
    unknownCapitalCount: number;
    returnPercent: number | null;
    returnOnBasePercent: number;
  };
  // Current mark-to-market of still-open lots across all positions — shown
  // separately, not folded into any month's return, since it isn't
  // realized yet and can still move either way before actually closing.
  openPositionsUnrealizedPnl: number;
  capitalBase: number;
  // capitalBase + all realized P&L to date + current open positions'
  // unrealized P&L — the single "what's my book worth right now" number.
  currentPortfolioValue: number;
};

/**
 * Monthly and cumulative performance from the paper-trade ledger, computed
 * fresh from whatever's currently stored — no separate cache to keep in
 * sync, so it's always up to date the moment a trade is closed (fully or
 * partially).
 *
 * Each entry in a trade's closedLots (see lib/kv.ts) is its own realized
 * event — a position added to and trimmed several times over its life
 * contributes one event per trim, not one event per position, each
 * counting toward the month IT was closed in (closedAt), not when the
 * position was originally opened. A month's return % is capital-weighted,
 * not an average of each event's own % return: sum of that month's P&L
 * divided by the sum of capitalReleased for the events that closed that
 * month, so a bigger position counts for more. There's no fixed starting
 * portfolio size assumed anywhere — "capital deployed" for a month is just
 * whatever capital the events that closed that month actually released,
 * summed.
 *
 * capitalBase is a separate, fixed reference point (see getCapitalBase in
 * lib/kv.ts) used only to express returns as a % of the whole book instead
 * of just the capital that happened to be at risk — it never affects the
 * capital-weighted returnPercent figures above.
 */
export function computePerformance(trades: PaperTrade[], capitalBase: number): PerformanceSummary {
  const events: ClosedLot[] = trades.flatMap((t) => t.closedLots);

  const byMonth = new Map<string, ClosedLot[]>();
  for (const e of events) {
    const month = e.closedAt.slice(0, 7);
    const arr = byMonth.get(month) ?? [];
    arr.push(e);
    byMonth.set(month, arr);
  }

  const monthly: MonthlyPerformance[] = Array.from(byMonth.keys())
    .sort()
    .map((month) => {
      const es = byMonth.get(month)!;
      let totalPnl = 0;
      let totalCapital = 0;
      let unknownCapitalCount = 0;
      let wins = 0;
      for (const e of es) {
        totalPnl += e.pnl;
        if (e.pnl > 0) wins++;
        if (typeof e.capitalReleased === "number") totalCapital += e.capitalReleased;
        else unknownCapitalCount++;
      }
      return {
        month,
        tradeCount: es.length,
        wins,
        losses: es.length - wins,
        totalPnl,
        totalCapital,
        unknownCapitalCount,
        returnPercent: totalCapital > 0 ? (totalPnl / totalCapital) * 100 : null,
        returnOnBasePercent: (totalPnl / capitalBase) * 100,
      };
    });

  let running = 0;
  const cumulativePnl = monthly.map((m) => {
    running += m.totalPnl;
    return { month: m.month, cumulative: running };
  });
  const portfolioValue = cumulativePnl.map((c) => ({ month: c.month, value: capitalBase + c.cumulative }));

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

  const openPositionsUnrealizedPnl = trades
    .filter((t) => t.status === "open" && t.lots > 0)
    .reduce((sum, t) => {
      const premium = t.lastMarkPremium ?? t.entryPremium;
      return sum + computePnlPerShare(t.mode, t.entryPremium, premium) * t.lots * t.lotSize;
    }, 0);

  return {
    monthly,
    cumulativePnl,
    portfolioValue,
    overall: {
      ...overallBase,
      returnPercent: overallBase.totalCapital > 0 ? (overallBase.totalPnl / overallBase.totalCapital) * 100 : null,
      returnOnBasePercent: (overallBase.totalPnl / capitalBase) * 100,
    },
    openPositionsUnrealizedPnl,
    capitalBase,
    currentPortfolioValue: capitalBase + overallBase.totalPnl + openPositionsUnrealizedPnl,
  };
}
