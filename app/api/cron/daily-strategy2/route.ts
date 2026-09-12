import { NextRequest, NextResponse } from "next/server";
import { getStoredAccessToken } from "@/lib/kv";
import { BATCH_IDS, type BatchId } from "@/lib/kv";
import { runDailyWtStrategy } from "@/lib/runWtStrategy";

// Strategy Tab 2's cron-triggered daily pass — see vercel.json for the
// three per-batch schedule entries (A/B/C), and api/cron/daily-strategy for
// the main Supertrend/SMA strategy's equivalent; this is a fully separate
// pipeline with its own Redis keys (see lib/kv.ts's saveWtSignalBatch).
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

  const result = await runDailyWtStrategy(accessToken, batchId);
  return NextResponse.json(result);
}
