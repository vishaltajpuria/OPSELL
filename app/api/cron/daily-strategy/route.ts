import { NextRequest, NextResponse } from "next/server";
import { getStoredAccessToken } from "@/lib/kv";
import { BATCH_IDS, type BatchId } from "@/lib/kv";
import { runDailyTimeframeStrategy } from "@/lib/runDailyStrategy";

// This is the Daily-timeframe pass only, covering the FULL F&O stock list
// (no pre-filtering) — see api/cron/daily-strategy-4h for the 4H pass,
// which is indices-only. Each call handles one batch (?batch=A/B/C — see
// vercel.json for the three separately-scheduled cron entries that cover
// all of them), so each invocation stays under Vercel Hobby's 60s hard cap
// (this maxDuration value is only honored on paid plans). runDailyTimeframeStrategy()
// checkpoint-saves after the stocks phase, so a Hobby timeout during the
// (much shorter) indices phase doesn't lose that batch's run.
export const maxDuration = 300;

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

function parseBatch(request: NextRequest): BatchId | null {
  const raw = request.nextUrl.searchParams.get("batch");
  return (BATCH_IDS as readonly string[]).includes(raw ?? "") ? (raw as BatchId) : null;
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const batchId = parseBatch(request);
  if (!batchId) {
    return NextResponse.json({ error: `batch query param must be one of ${BATCH_IDS.join(", ")}.` }, { status: 400 });
  }

  const accessToken = await getStoredAccessToken();
  if (!accessToken) {
    return NextResponse.json(
      { error: "No stored Zerodha session. Open the app and connect to Zerodha first today." },
      { status: 400 }
    );
  }

  const result = await runDailyTimeframeStrategy(accessToken, batchId);
  return NextResponse.json(result);
}
