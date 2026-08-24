import { redirect } from "next/navigation";
import { isConnected } from "@/lib/session";
import PaperTradingBoard from "@/components/PaperTradingBoard";

export const dynamic = "force-dynamic";

export default function PaperTradingPage() {
  if (!isConnected()) redirect("/settings");

  return (
    <main className="px-4 pt-6">
      <h1 className="text-xl font-semibold">Paper Trading</h1>
      <p className="mt-1 text-sm text-muted">
        Test the strategy with real option prices, without real money. Nothing here executes a real order — every
        trade is manual: pick a candidate, review the live quote, confirm to open, close whenever you want.
      </p>
      <div className="mt-4">
        <PaperTradingBoard />
      </div>
    </main>
  );
}
