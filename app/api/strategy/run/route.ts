import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/lib/session";
import { BATCH_IDS, type BatchId } from "@/lib/kv";
import { runDailyTimeframeStrategy } from "@/lib/runDailyStrategy";

// Daily-timeframe pass only, covering the full F&O stock list — see
// api/strategy/run-4h for the 4H pass (indices only). Runs one batch at a
// time (?batch=A/B/C); the Strategy tab's button calls all of them plus
// the 4H pass in sequence to cover everything. Same duration profile as
// the cron job — see its route for the Hobby-plan 60s ceiling note.
export const maxDuration = 300;

function parseBatch(request: NextRequest): BatchId | null {
  const raw = request.nextUrl.searchParams.get("batch");
  return (BATCH_IDS as readonly string[]).includes(raw ?? "") ? (raw as BatchId) : null;
}

export async function POST(request: NextRequest) {
  const accessToken = getAccessToken();
  if (!accessToken) {
    return NextResponse.json({ error: "Not connected to Zerodha." }, { status: 401 });
  }

  const batchId = parseBatch(request);
  if (!batchId) {
    return NextResponse.json({ error: `batch query param must be one of ${BATCH_IDS.join(", ")}.` }, { status: 400 });
  }

  try {
    const result = await runDailyTimeframeStrategy(accessToken, batchId);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to run the strategy.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
