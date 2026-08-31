import { NextRequest, NextResponse } from "next/server";
import { getStoredAccessToken } from "@/lib/kv";
import { BATCH_IDS, type BatchId } from "@/lib/kv";
import { run4HTimeframeStrategy } from "@/lib/runDailyStrategy";

// The 4H-timeframe pass — indices only now (see api/cron/daily-strategy for
// the Daily pass, which covers the full F&O stock list). Only ?batch=A
// does real work (run4HTimeframeStrategy itself gates on it — 5 indices is
// cheap enough for one invocation), so vercel.json only schedules that one
// batch, staggered after the Daily pass's own cron entries.
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
