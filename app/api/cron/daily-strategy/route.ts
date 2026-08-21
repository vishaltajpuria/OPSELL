import { NextRequest, NextResponse } from "next/server";
import { getStoredAccessToken } from "@/lib/kv";
import { runDailyStrategy } from "@/lib/runDailyStrategy";

// Vercel Hobby caps function duration at 60s. With ~150-200 liquid stocks to
// scan at Kite's 3 req/sec historical-data limit, this can get close to that
// ceiling — if it starts timing out as the liquid list grows, this needs
// either a Pro plan (higher maxDuration) or splitting the run across two
// invocations.
export const maxDuration = 60;

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

  const result = await runDailyStrategy(accessToken);
  return NextResponse.json(result);
}
