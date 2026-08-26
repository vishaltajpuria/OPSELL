import { NextResponse } from "next/server";
import { listFnoStocks } from "@/lib/instruments";
import { INDEX_DEFS } from "@/lib/indices";
import { isConnected } from "@/lib/session";

export async function GET() {
  if (!isConnected()) {
    return NextResponse.json({ error: "Not connected to Zerodha." }, { status: 401 });
  }
  try {
    const stocks = await listFnoStocks();
    // SENSEX trades on BSE, not NFO, and this app only fetches NFO option
    // instrument data (lib/instruments.ts) — offering it here would just
    // lead to a dead-end "no option chain data" error, so it's left out
    // rather than offered.
    const indices = INDEX_DEFS.filter((d) => d.exchange === "NSE").map((d) => ({ key: d.key, label: d.label }));
    return NextResponse.json({ stocks, indices });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load F&O stock list.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
