import { NextResponse } from "next/server";
import { listFnoStocks } from "@/lib/instruments";
import { isConnected } from "@/lib/session";

export async function GET() {
  if (!isConnected()) {
    return NextResponse.json({ error: "Not connected to Zerodha." }, { status: 401 });
  }
  try {
    const stocks = await listFnoStocks();
    return NextResponse.json({ stocks });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load F&O stock list.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
