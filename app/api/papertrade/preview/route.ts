import { NextRequest, NextResponse } from "next/server";
import { isConnected } from "@/lib/session";
import { buildTradePlan } from "@/lib/paperTrading";

// Resolves a candidate signal into a concrete, priced trade plan for the
// user to review before confirming — nothing is persisted here. /start
// re-resolves the same plan fresh at confirm time rather than trusting
// whatever this returned, since some time may have passed and prices move.
export async function POST(request: NextRequest) {
  if (!isConnected()) {
    return NextResponse.json({ error: "Not connected to Zerodha." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const symbol = typeof body?.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const direction = body?.direction === "short" || body?.direction === "long" ? body.direction : null;
  const mode = body?.mode === "buy" || body?.mode === "sell" ? body.mode : null;
  if (!symbol || !direction || !mode) {
    return NextResponse.json({ error: "symbol, direction ('short'|'long'), and mode ('buy'|'sell') are required." }, { status: 400 });
  }

  try {
    const plan = await buildTradePlan(symbol, direction, mode);
    return NextResponse.json(plan);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to build a trade plan.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
