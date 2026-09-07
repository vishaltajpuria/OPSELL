import { redirect } from "next/navigation";
import { isConnected } from "@/lib/session";
import { getMarketStatus, marketClosedMessage } from "@/lib/marketHours";
import PaperTradePositions from "@/components/PaperTradePositions";

export const dynamic = "force-dynamic";

export default function PositionsPage() {
  if (!isConnected()) redirect("/settings");

  const marketStatus = getMarketStatus();

  return (
    <main className="px-4 pt-6">
      <h1 className="text-xl font-semibold">Positions</h1>
      <p className="mt-1 text-sm text-muted">Your open and closed paper trades — nothing here is a real order.</p>
      {!marketStatus.open && (
        <p className="mt-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          {marketClosedMessage(marketStatus)} Adding to or closing a position is disabled until the market's open.
        </p>
      )}
      <div className="mt-4">
        <PaperTradePositions />
      </div>
    </main>
  );
}
