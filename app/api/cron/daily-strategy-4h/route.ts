import { NextRequest, NextResponse } from "next/server";
import { getStoredAccessToken } from "@/lib/kv";
import { run4HTimeframeStrategy } from "@/lib/runDailyStrategy";

// The 4H-timeframe pass — see api/cron/daily-strategy for the Daily pass,
// run as a separate invocation (and scheduled a few minutes apart in
// vercel.json) so each stays under Vercel Hobby's 60s hard cap, and so the
// two don't run concurrently against Kite's 3 req/sec historical-data limit.
export const maxDuration = 300;

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accessToken = await getStoredAccessToken();
  if (!accessToken) {
    return NextResponse.json(
      { error: "No stored Zerodha session. Open the app and connect to Zerodha first today." },
      { status: 400 }
    );
  }

  const result = await run4HTimeframeStrategy(accessToken);
  return NextResponse.json(result);
}
