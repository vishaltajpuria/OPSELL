import { NextRequest, NextResponse } from "next/server";
import { isConnected } from "@/lib/session";
import { getOptionExpiries } from "@/lib/instruments";

// Every real, upcoming-or-not expiry a symbol has listed — feeds the
// "choose expiry myself" picker in the trade preview (see
// resolveManualExpiry in lib/paperTrading.ts), so the user can see and pick
// exactly which contract they're pricing instead of trusting the
// auto-picker's near/next-month or weekly/monthly rules.
export async function GET(request: NextRequest) {
  if (!isConnected()) {
    return NextResponse.json({ error: "Not connected to Zerodha." }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol")?.trim().toUpperCase();
  if (!symbol) {
    return NextResponse.json({ error: "symbol is required." }, { status: 400 });
  }
  try {
    const expiries = await getOptionExpiries(symbol);
    return NextResponse.json({ expiries });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load expiries.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
