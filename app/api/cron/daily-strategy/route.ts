import { NextRequest, NextResponse } from "next/server";
import { getStoredAccessToken } from "@/lib/kv";
import { runDailyStrategy } from "@/lib/runDailyStrategy";

// Scanning every F&O stock (not just the Liquid bucket) at Kite's 3 req/sec
// historical-data limit takes a while. Vercel Hobby hard-caps function
// duration at 60s regardless of this value; Pro allows up to this figure.
// runDailyStrategy() checkpoint-saves after the stocks phase, so a Hobby
// timeout during the (much shorter) indices phase doesn't lose the run.
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

  const result = await runDailyStrategy(accessToken);
  return NextResponse.json(result);
}
