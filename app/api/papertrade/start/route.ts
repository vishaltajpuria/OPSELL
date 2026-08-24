import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isConnected } from "@/lib/session";
import { requireAccessToken } from "@/lib/kite";
import { buildTradePlan, computeCapitalRequired } from "@/lib/paperTrading";
import { getPaperTrades, savePaperTrades, type PaperTrade } from "@/lib/kv";

// Opens a new paper trade. Re-resolves the trade plan fresh (same as
// /preview) rather than trusting anything the client sends beyond
// symbol/direction/mode/lots, so the recorded entry premium is always a
// just-fetched live price, not a stale one from whenever the user was
// looking at the preview screen.
export async function POST(request: NextRequest) {
  if (!isConnected()) {
    return NextResponse.json({ error: "Not connected to Zerodha." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const symbol = typeof body?.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const direction = body?.direction === "short" || body?.direction === "long" ? body.direction : null;
  const mode = body?.mode === "buy" || body?.mode === "sell" ? body.mode : null;
  const lots = typeof body?.lots === "number" && Number.isInteger(body.lots) && body.lots > 0 ? body.lots : null;
  if (!symbol || !direction || !mode || !lots) {
    return NextResponse.json(
      { error: "symbol, direction ('short'|'long'), mode ('buy'|'sell'), and a positive integer lots are required." },
      { status: 400 }
    );
  }

  try {
    const plan = await buildTradePlan(symbol, direction, mode);
    const capitalRequired = await computeCapitalRequired(plan, lots, requireAccessToken());
    const now = new Date().toISOString();
    const trade: PaperTrade = {
      id: randomUUID(),
      symbol,
      direction,
      mode,
      expiry: plan.expiry,
      tradingSessionsUntilExpiryAtEntry: plan.tradingSessionsUntilExpiry,
      shortLeg: { tradingsymbol: plan.shortLeg.tradingsymbol, strike: plan.shortLeg.strike, optionType: plan.shortLeg.optionType },
      longLeg: plan.longLeg
        ? { tradingsymbol: plan.longLeg.tradingsymbol, strike: plan.longLeg.strike, optionType: plan.longLeg.optionType }
        : null,
      lots,
      lotSize: plan.shortLeg.lotSize,
      entryAt: now,
      entryUnderlyingPrice: plan.underlyingPrice,
      entryPremium: plan.entryPremium,
      capitalRequired,
      status: "open",
      exitAt: null,
      exitUnderlyingPrice: null,
      exitPremium: null,
      lastMarkPremium: plan.entryPremium,
      lastMarkAt: now,
    };

    const trades = await getPaperTrades();
    trades.push(trade);
    await savePaperTrades(trades);

    return NextResponse.json({ trade });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start the trade.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
