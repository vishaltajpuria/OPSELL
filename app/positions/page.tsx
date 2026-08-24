import { redirect } from "next/navigation";
import { isConnected } from "@/lib/session";
import PaperTradePositions from "@/components/PaperTradePositions";

export const dynamic = "force-dynamic";

export default function PositionsPage() {
  if (!isConnected()) redirect("/settings");

  return (
    <main className="px-4 pt-6">
      <h1 className="text-xl font-semibold">Positions</h1>
      <p className="mt-1 text-sm text-muted">Your open and closed paper trades — nothing here is a real order.</p>
      <div className="mt-4">
        <PaperTradePositions />
      </div>
    </main>
  );
}
