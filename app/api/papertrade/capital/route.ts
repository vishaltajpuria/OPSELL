import { NextRequest, NextResponse } from "next/server";
import { isConnected } from "@/lib/session";
import { getCapitalBase, setCapitalBase } from "@/lib/kv";

export async function GET() {
  if (!isConnected()) {
    return NextResponse.json({ error: "Not connected to Zerodha." }, { status: 401 });
  }
  try {
    const capitalBase = await getCapitalBase();
    return NextResponse.json({ capitalBase });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load the capital base.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!isConnected()) {
    return NextResponse.json({ error: "Not connected to Zerodha." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const amount = body?.capitalBase;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "capitalBase must be a positive number." }, { status: 400 });
  }

  try {
    await setCapitalBase(amount);
    return NextResponse.json({ capitalBase: amount });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update the capital base.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
