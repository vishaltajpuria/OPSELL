import type { PaperTrade, ClosedLot } from "@/lib/kv";
import { computePnlPerShare, buildCapitalTimeline, type CapitalTimelinePoint } from "@/lib/paperTrading";

export type MonthlyPerformance = {
  month: string; // "YYYY-MM"
  tradeCount: number; // number of close EVENTS (a partial close counts on its own), not distinct positions
  wins: number;
  losses: number;
  totalPnl: number; // ₹, realized THIS MONTH only (events whose closedAt falls in this month)
  // Peak total capital the WHOLE portfolio had deployed at any single
  // point in time during this month — not a sum of what happened to close
  // this month. A position opened in an earlier month and still open
  // through this one counts toward this month's peak too, for as long as
  // it overlaps it.
  maxCapitalDeployed: number;
  returnPercent: number | null; // totalPnl / maxCapitalDeployed * 100 — null if nothing was ever deployed this month (maxCapitalDeployed is 0)
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
    maxCapitalDeployed: number; // peak total capital deployed at any point across the WHOLE trading history (including right now, if a position is still open)
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

function monthBounds(monthKey: string): { start: string; end: string } {
  const [y, m] = monthKey.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1)).toISOString();
  const end = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1)).toISOString();
  return { start, end };
}

/**
 * The peak of a capital-deployed step-function timeline (see
 * buildCapitalTimeline in lib/paperTrading.ts) within [startIso, endIso) —
 * the level carried in from before the window (the last point at or before
 * `startIso`) counts too, since a position opened earlier and still open
 * through this window was genuinely deploying capital throughout it, not
 * starting fresh at 0. Between two points a step function is constant, so
 * its max over any interval is always achieved exactly at one of the step
 * points (the carried-in level, or right after an event inside the
 * window) — no need to also check "just before the window ends".
 */
function maxCapitalInRange(timeline: CapitalTimelinePoint[], startIso: string, endIso: string): number {
  let carriedIn = 0;
  let maxInside = 0;
  for (const p of timeline) {
    if (p.at <= startIso) carriedIn = p.total;
    else if (p.at < endIso && p.total > maxInside) maxInside = p.total;
  }
  return Math.max(carriedIn, maxInside);
}

/**
 * Monthly and cumulative performance from the paper-trade ledger, computed
 * fresh from whatever's currently stored — no separate cache to keep in
 * sync, so it's always up to date the moment a trade is closed (fully or
 * partially).
 *
 * Each entry in a trade's closedLots (see lib/kv.ts) is its own realized
 * event — a position added to and trimmed several times over its life
 * contributes one event per trim, not one event per position, each
 * counting toward the month IT was closed in (closedAt), independently. A
 * position added to and trimmed three times over two months contributes to
 * however many of those months it was actually trimmed in, at that trim's
 * own P&L — not one lump sum attributed to whenever it finally reaches
 * zero. An open position's mark-to-market never affects a month's return
 * (shown separately, as a single "currently unrealized" note, since it can
 * still move either way before you actually close it).
 *
 * A month's return % is realized P&L divided by the PEAK total capital the
 * whole portfolio actually had deployed at any single point in time during
 * that month (`maxCapitalDeployed`, reconstructed from every trade's
 * capitalHistory — see buildCapitalTimeline) — not the sum of capital that
 * happened to be released by events closing that month, which could wildly
 * over- or under-state how hard the capital was actually working: summing
 * overstates it when several non-overlapping positions each release their
 * own capital in the same month (you never had all of it deployed at
 * once), and understates it when a position stays open past month-end
 * (its capital was fully at risk all month, but contributes nothing to a
 * "released this month" sum since it hasn't released yet).
 *
 * capitalBase is a separate, fixed reference point (see getCapitalBase in
 * lib/kv.ts) used only to express returns as a % of the whole book instead
 * of just the capital that happened to be at risk — it never affects the
 * capital-weighted returnPercent figures above.
 */
export function computePerformance(trades: PaperTrade[], capitalBase: number): PerformanceSummary {
  const events: ClosedLot[] = trades.flatMap((t) => t.closedLots);
  const timeline = buildCapitalTimeline(trades);

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
      let wins = 0;
      for (const e of es) {
        totalPnl += e.pnl;
        if (e.pnl > 0) wins++;
      }
      const { start, end } = monthBounds(month);
      const maxCapitalDeployed = maxCapitalInRange(timeline, start, end);
      return {
        month,
        tradeCount: es.length,
        wins,
        losses: es.length - wins,
        totalPnl,
        maxCapitalDeployed,
        returnPercent: maxCapitalDeployed > 0 ? (totalPnl / maxCapitalDeployed) * 100 : null,
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
    }),
    { tradeCount: 0, wins: 0, losses: 0, totalPnl: 0 }
  );
  // The peak across the WHOLE history equals the max of the timeline's own
  // totals — including its very last point, which reflects right now (a
  // still-open position's most recent capital change), not just a
  // historical month's peak.
  const overallMaxCapitalDeployed = timeline.reduce((max, p) => Math.max(max, p.total), 0);

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
      maxCapitalDeployed: overallMaxCapitalDeployed,
      returnPercent: overallMaxCapitalDeployed > 0 ? (overallBase.totalPnl / overallMaxCapitalDeployed) * 100 : null,
      returnOnBasePercent: (overallBase.totalPnl / capitalBase) * 100,
    },
    openPositionsUnrealizedPnl,
    capitalBase,
    currentPortfolioValue: capitalBase + overallBase.totalPnl + openPositionsUnrealizedPnl,
  };
}
