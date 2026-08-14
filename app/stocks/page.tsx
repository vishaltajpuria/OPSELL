import { redirect } from "next/navigation";
import { isConnected } from "@/lib/session";
import { listFnoStocks } from "@/lib/instruments";
import StockList from "@/components/StockList";

export const dynamic = "force-dynamic";

export default async function StocksPage() {
  if (!isConnected()) redirect("/settings");

  try {
    const stocks = await listFnoStocks();
    return (
      <main>
        <header className="px-4 pt-6">
          <h1 className="text-xl font-semibold">F&O Stocks</h1>
          <p className="text-sm text-muted">NSE stocks with listed futures &amp; options</p>
        </header>
        <StockList stocks={stocks} />
      </main>
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load stocks.";
    return (
      <main className="px-4 pt-6">
        <p className="rounded-xl border border-danger/40 bg-danger/10 p-4 text-sm text-danger">{message}</p>
      </main>
    );
  }
}
