import { NextRequest, NextResponse } from "next/server";
import { getOptionChain } from "@/lib/optionChain";
import { isConnected } from "@/lib/session";

export async function GET(request: NextRequest) {
  if (!isConnected()) {
    return NextResponse.json({ error: "Not connected to Zerodha." }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol");
  const expiry = searchParams.get("expiry");
  if (!symbol || !expiry) {
    return NextResponse.json({ error: "symbol and expiry are required." }, { status: 400 });
  }
  try {
    const chain = await getOptionChain(symbol, expiry);
    return NextResponse.json(chain);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load option chain.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
