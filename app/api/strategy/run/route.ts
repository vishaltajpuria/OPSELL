import { NextResponse } from "next/server";
import { getAccessToken } from "@/lib/session";
import { runDailyStrategy } from "@/lib/runDailyStrategy";

// Same duration profile as the cron job — see its route for the Hobby-plan
// 60s ceiling note.
export const maxDuration = 300;

export async function POST() {
  const accessToken = getAccessToken();
  if (!accessToken) {
    return NextResponse.json({ error: "Not connected to Zerodha." }, { status: 401 });
  }

  try {
    const result = await runDailyStrategy(accessToken);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to run the strategy.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
