import { redirect } from "next/navigation";
import { isConnected } from "@/lib/session";
import BacktestRunner from "@/components/BacktestRunner";

export const dynamic = "force-dynamic";

export default function BacktestPage() {
  if (!isConnected()) redirect("/settings");

  return (
    <main className="px-4 pt-6">
      <h1 className="text-xl font-semibold">Backtest</h1>
      <BacktestRunner />
    </main>
  );
}
