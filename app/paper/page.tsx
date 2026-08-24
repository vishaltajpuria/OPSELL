import { redirect } from "next/navigation";
import { isConnected } from "@/lib/session";
import { getLatestSignals, type StoredSignal } from "@/lib/kv";
import PaperTradeCandidates from "@/components/PaperTradeCandidates";

export const dynamic = "force-dynamic";

export default async function PaperTradePage() {
  if (!isConnected()) redirect("/settings");

  let runAt: string | null = null;
  let error: string | null = null;
  let candidates: StoredSignal[] = [];
  try {
    const latest = await getLatestSignals();
    runAt = latest?.runAt ?? null;
    candidates = latest ? latest.signals.filter((s) => s.timeframe === "1D") : [];
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load signals.";
  }

  return (
    <main className="px-4 pt-6">
      <h1 className="text-xl font-semibold">Trade</h1>
      <p className="mt-1 text-sm text-muted">
        Preview and open a paper trade against real option prices — see the <b>Positions</b> tab for what's open.
      </p>
      {error && (
        <p className="mt-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</p>
      )}
      {!error && (
        <div className="mt-4">
          <PaperTradeCandidates candidates={candidates} runAt={runAt} />
        </div>
      )}
    </main>
  );
}
