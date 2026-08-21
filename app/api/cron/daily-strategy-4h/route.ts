import { NextRequest, NextResponse } from "next/server";
import { getStoredAccessToken } from "@/lib/kv";
import { BATCH_IDS, type BatchId } from "@/lib/kv";
import { run4HTimeframeStrategy } from "@/lib/runDailyStrategy";

// The 4H-timeframe pass — see api/cron/daily-strategy for the Daily pass.
// Each call handles one batch (?batch=A or ?batch=B — see vercel.json for
// the two separately-scheduled cron entries, staggered from each other and
// from the Daily pass's entries) so each invocation stays under Vercel
// Hobby's 60s hard cap and doesn't collide with another batch on Kite's
// shared 3 req/sec historical-data limit.
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

  const result = await run4HTimeframeStrategy(accessToken, batchId);
  return NextResponse.json(result);
}
