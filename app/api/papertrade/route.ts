import { NextResponse } from "next/server";
import { isConnected } from "@/lib/session";
import { getLatestSignals, getPaperTrades } from "@/lib/kv";

export const dynamic = "force-dynamic";

// Candidates + the full paper-trade ledger for the paper trading tab.
// Candidates are today's Daily signals from the same live scan the Strategy
// tab reads (signals:latest) — paper trading is manual-entry only (no
// automated writer), so this just surfaces what's already live for you to
// choose from, it doesn't compute anything new.
export async function GET() {
  if (!isConnected()) {
    return NextResponse.json({ error: "Not connected to Zerodha." }, { status: 401 });
  }

  try {
    const [latest, trades] = await Promise.all([getLatestSignals(), getPaperTrades()]);
    const candidates = (latest?.signals ?? []).filter((s) => s.timeframe === "1D");
    return NextResponse.json({
      runAt: latest?.runAt ?? null,
      candidates,
      trades: [...trades].sort((a, b) => b.entryAt.localeCompare(a.entryAt)),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load paper trading data.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
