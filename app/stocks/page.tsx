import { redirect } from "next/navigation";
import { isConnected } from "@/lib/session";
import { getStockLiquidity } from "@/lib/liquidity";
import { getIndexQuotes } from "@/lib/indices";
import StockScanner from "@/components/StockScanner";

export const dynamic = "force-dynamic";

export default async function StocksPage() {
  if (!isConnected()) redirect("/settings");

  try {
    const [stocks, indices] = await Promise.all([getStockLiquidity(), getIndexQuotes()]);
    const liquidStocks = stocks.filter((s) => s.bucket === "liquid");
    const illiquidStocks = stocks.filter((s) => s.bucket === "illiquid");

    return (
      <main>
        <header className="px-4 pt-6">
          <h1 className="text-xl font-semibold">F&O Scanner</h1>
          <p className="text-sm text-muted">NSE stocks with listed futures &amp; options</p>
        </header>
        <StockScanner liquidStocks={liquidStocks} illiquidStocks={illiquidStocks} indices={indices} />
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
