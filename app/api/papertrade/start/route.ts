import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isConnected } from "@/lib/session";
import { requireAccessToken, KiteAuthError } from "@/lib/kite";
import { buildTradePlan, computeCapitalRequired, findOpenTrade } from "@/lib/paperTrading";
import { getPaperTrades, savePaperTrades, type PaperTrade } from "@/lib/kv";

// Opens a brand-new paper trade. Re-resolves the trade plan fresh (same as
// /preview) rather than trusting anything the client sends beyond
// symbol/direction/mode/lots/strike(s), so the recorded entry premium is
// always a just-fetched live price, not a stale one from whenever the user
// was looking at the preview screen — the strike(s), if given, pin WHICH
// contract to price fresh, not what its price is.
//
// Refuses to open a second position for a (symbol, mode) that already has
// one open — /preview should have routed the client to /increase instead,
// but this is the server-side backstop, since opening a second position at
// a possibly-different strike (today's ATM/OTM can differ from the
// existing position's) rather than adding to the existing one at its own
// strike is exactly what was asked to be avoided.
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
  // Same optional manual-strikes override as /preview (single strike for
  // buy mode, a pair for sell mode) — passed through here too so the
  // strikes that actually get confirmed match whatever the user reviewed
  // on the preview screen, rather than re-picking automatically at confirm
  // time (spot can move between preview and confirm).
  const manualStrikes =
    typeof body?.shortStrike === "number"
      ? { short: body.shortStrike, long: typeof body?.longStrike === "number" ? body.longStrike : undefined }
      : undefined;
  // Same optional weekly-expiry override as /preview (NIFTY only —
  // buildTradePlan enforces that).
  const expiryMode = body?.expiryMode === "weekly" ? "weekly" : "monthly";

  try {
    const trades = await getPaperTrades();
    if (findOpenTrade(trades, symbol, mode)) {
      return NextResponse.json(
        { error: `Already have an open ${mode} position on ${symbol} — use the increase option on it instead of opening a new one.` },
        { status: 409 }
      );
    }

    const plan = await buildTradePlan(symbol, direction, mode, manualStrikes, expiryMode);
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
      closedLots: [],
      lastMarkPremium: plan.entryPremium,
      lastMarkAt: now,
      todayPnl: 0, // just opened at entryPremium = current — the day's move so far is exactly zero
      currentUnderlyingPrice: plan.underlyingPrice,
      // The day-change needs a live quote's previous close, which
      // buildTradePlan doesn't fetch (it only needs the current spot to
      // pick strikes) — filled in by the first Live press instead.
      underlyingChangeValue: null,
      underlyingChangePercent: null,
      capitalHistory: typeof capitalRequired === "number" ? [{ at: now, capitalRequired }] : [],
    };

    trades.push(trade);
    await savePaperTrades(trades);

    return NextResponse.json({ trade });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start the trade.";
    return NextResponse.json({ error: message }, { status: err instanceof KiteAuthError ? 401 : 400 });
  }
}
