import { redirect, notFound } from "next/navigation";
import { isConnected } from "@/lib/session";
import { listFnoStocks } from "@/lib/instruments";
import { getOptionChain } from "@/lib/optionChain";
import OptionChainView from "@/components/OptionChainView";

export const dynamic = "force-dynamic";

export default async function StockPage({ params }: { params: { symbol: string } }) {
  if (!isConnected()) redirect("/settings");

  const symbol = decodeURIComponent(params.symbol);
  const stocks = await listFnoStocks();
  const stock = stocks.find((s) => s.name === symbol);
  if (!stock || stock.expiries.length === 0) notFound();

  const nearestExpiry = stock.expiries[0];
  const chain = await getOptionChain(symbol, nearestExpiry);

  return <OptionChainView symbol={symbol} expiries={stock.expiries} initialChain={chain} />;
}
