import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/lib/session";
import { BATCH_IDS, type BatchId } from "@/lib/kv";
import { runStrategy3 } from "@/lib/runStrategy3";

// Strategy Tab 3's manual "Run now" endpoint — one batch at a time
// (?batch=A/B/C). See api/strategy/run2 for Strategy Tab 2's equivalent;
// this is a fully separate pipeline.
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
    const result = await runStrategy3(accessToken, batchId);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to run the strategy.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
