import { NextResponse } from "next/server";
import { isConnected } from "@/lib/session";
import { requireAccessToken } from "@/lib/kite";
import { findDuplicateOpenGroups, mergeOpenTradeGroup, computeMarginForQuantity } from "@/lib/paperTrading";
import { getPaperTrades, savePaperTrades } from "@/lib/kv";

// Finds open positions that are genuinely the same contract (same symbol,
// mode, and leg(s)) recorded as two or more separate trades — e.g. from
// opening the same position twice before /start's same-(symbol,mode) guard
// existed — and combines each such group into one. Non-duplicate trades are
// left untouched. Safe to call with nothing to merge (returns merged: 0).
export async function POST() {
  if (!isConnected()) {
    return NextResponse.json({ error: "Not connected to Zerodha." }, { status: 401 });
  }

  try {
    const trades = await getPaperTrades();
    const groups = findDuplicateOpenGroups(trades);
    if (groups.length === 0) {
      return NextResponse.json({ merged: 0, trades });
    }

    const accessToken = requireAccessToken();
    const groupIds = new Set(groups.flat().map((t) => t.id));
    const mergedTrades = [];
    for (const group of groups) {
      const merged = mergeOpenTradeGroup(group);
      merged.capitalRequired = await computeMarginForQuantity(merged, merged.lots, accessToken);
      mergedTrades.push(merged);
    }

    const untouched = trades.filter((t) => !groupIds.has(t.id));
    const result = [...untouched, ...mergedTrades];
    await savePaperTrades(result);

    return NextResponse.json({ merged: groups.length, trades: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to merge duplicate positions.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
