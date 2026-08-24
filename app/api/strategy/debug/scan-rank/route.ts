import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/lib/session";
import { listFnoStocks } from "@/lib/instruments";
import { computeScanInputs, rankAllCandidates, TOP_N } from "@/lib/scanFilter";

// Temporary debugging aid: shows exactly where every F&O stock lands in the
// pre-scan filter's ranking (lib/scanFilter.ts) — the OI/volume/move
// percentiles behind its score, its rank, and whether it made the top-TOP_N
// cut that actually gets scanned for signals. Answers "was this stock
// filtered out, or did it just not qualify" without needing to guess. Not
// linked from the UI.
export async function GET(request: NextRequest) {
  const accessToken = getAccessToken();
  if (!accessToken) {
    return NextResponse.json({ error: "Not connected to Zerodha." }, { status: 401 });
  }

  const symbol = request.nextUrl.searchParams.get("symbol")?.trim().toUpperCase() || null;

  try {
    const stocks = await listFnoStocks(accessToken);
    const inputs = await computeScanInputs(stocks, accessToken);
    const ranked = rankAllCandidates(inputs);

    if (symbol) {
      const entry = ranked.find((r) => r.name === symbol);
      if (!entry) {
        return NextResponse.json(
          { error: `${symbol} not found in today's F&O stock list.`, totalStocks: ranked.length },
          { status: 404 }
        );
      }
      return NextResponse.json({
        symbol,
        totalStocks: ranked.length,
        topN: TOP_N,
        madeTheCut: entry.rank <= TOP_N,
        ...entry,
        cutoffScore: ranked[Math.min(TOP_N, ranked.length) - 1]?.score ?? null,
      });
    }

    return NextResponse.json({ totalStocks: ranked.length, topN: TOP_N, ranked });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to compute scan ranking.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
