import { redirect } from "next/navigation";
import { isConnected, getAccessToken } from "@/lib/session";
import { getPositions, type Position } from "@/lib/kite";

export const dynamic = "force-dynamic";

function fmt(n: number) {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function signedFmt(n: number) {
  return `${n >= 0 ? "+" : ""}${fmt(n)}`;
}

export default async function PositionsPage() {
  if (!isConnected()) redirect("/settings");

  let positions: Position[] = [];
  let error: string | null = null;
  try {
    const accessToken = getAccessToken()!;
    const data = await getPositions(accessToken);
    // Net positions with quantity 0 are ones that were opened and fully
    // closed today — nothing currently open to show.
    positions = data.net.filter((p) => p.quantity !== 0);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load positions.";
  }

  const totalPnl = positions.reduce((sum, p) => sum + p.pnl, 0);

  return (
    <main className="px-4 pt-6">
      <h1 className="text-xl font-semibold">Positions</h1>
      <p className="mt-1 text-sm text-muted">Live from your Zerodha account</p>

      {error && (
        <p className="mt-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</p>
      )}

      {!error && positions.length === 0 && (
        <div className="mt-6 rounded-xl border border-border bg-surface p-5 text-center">
          <p className="text-3xl">📭</p>
          <p className="mt-3 text-sm text-muted">No open positions right now.</p>
        </div>
      )}

      {!error && positions.length > 0 && (
        <>
          <p className={`mt-4 text-sm font-semibold ${totalPnl >= 0 ? "text-accent" : "text-danger"}`}>
            Total P&amp;L: {signedFmt(totalPnl)}
          </p>
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {positions.map((p) => (
              <li key={`${p.exchange}:${p.tradingsymbol}:${p.product}`} className="bg-surface px-4 py-3.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{p.tradingsymbol}</span>
                  <span className={`text-sm font-semibold ${p.pnl >= 0 ? "text-accent" : "text-danger"}`}>
                    {signedFmt(p.pnl)}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-muted">
                  {p.product} · {p.quantity > 0 ? "Long" : "Short"} {Math.abs(p.quantity)} · Avg {fmt(p.average_price)}{" "}
                  · LTP {fmt(p.last_price)}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
