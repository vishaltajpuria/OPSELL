"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Strategy Tab 2 is Daily-only (no 4H) — 3 batches instead of the main
// Strategy tab's 4 stages. See components/RunStrategyButton.tsx for why
// these run sequentially rather than in parallel (shared Kite rate limit,
// each needs its own Vercel duration budget).
const STAGES = [
  { label: "Daily (1 of 3)", url: "/api/strategy/run2?batch=A" },
  { label: "Daily (2 of 3)", url: "/api/strategy/run2?batch=B" },
  { label: "Daily (3 of 3)", url: "/api/strategy/run2?batch=C" },
] as const;

type Status = "idle" | "running" | "error";

async function runOne(url: string): Promise<{ signalCount: number }> {
  const res = await fetch(url, { method: "POST" });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error ?? "Failed to run the strategy.");
  }
  return data;
}

export default function RunWtStrategyButton() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [stageIndex, setStageIndex] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setMessage(null);
    setStatus("running");
    let totalSignals = 0;
    try {
      for (let i = 0; i < STAGES.length; i++) {
        setStageIndex(i);
        const result = await runOne(STAGES[i].url);
        totalSignals += result.signalCount;
        router.refresh();
      }
      setStatus("idle");
      setMessage(`Done — ${totalSignals} signal${totalSignals === 1 ? "" : "s"} found.`);
    } catch (err) {
      setStatus("error");
      const detail = err instanceof Error ? err.message : String(err);
      setMessage(
        `Lost connection while waiting (${detail}). Check the "Last run" time below — some batches may have finished anyway.`
      );
      router.refresh();
    }
  }

  const running = status === "running";

  return (
    <div className="mb-4">
      <button
        onClick={run}
        disabled={running}
        className="w-full rounded-xl bg-accent px-4 py-3 text-center text-sm font-medium text-black disabled:opacity-60"
      >
        {running ? `Running… ${STAGES[stageIndex].label}` : "Run strategy now"}
      </button>
      {running && (
        <p className="mt-2 text-xs text-muted">
          Covers the full F&amp;O list in 3 stages and can take a couple of minutes — keep this screen open and
          your phone unlocked.
        </p>
      )}
      {message && (
        <p className={`mt-2 text-xs ${status === "error" ? "text-danger" : "text-muted"}`}>{message}</p>
      )}
    </div>
  );
}
