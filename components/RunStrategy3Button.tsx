"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Strategy Tab 3 is Daily-only (no separate 4H stage) — 4H is part of the
// gate itself (see lib/strategy3.ts), fetched per-symbol within each batch,
// not a later pass. 3 batches, same reasoning as
// components/RunWtStrategyButton.tsx (shared Kite rate limit, each needs
// its own Vercel duration budget).
const STAGES = [
  { label: "1 of 3", url: "/api/strategy/run3?batch=A" },
  { label: "2 of 3", url: "/api/strategy/run3?batch=B" },
  { label: "3 of 3", url: "/api/strategy/run3?batch=C" },
] as const;

type Status = "idle" | "running" | "error";

async function runOne(url: string): Promise<{ signalCount: number; errorCount: number }> {
  const res = await fetch(url, { method: "POST" });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error ?? "Failed to run the strategy.");
  }
  return data;
}

export default function RunStrategy3Button() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [stageIndex, setStageIndex] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setMessage(null);
    setStatus("running");
    let totalSignals = 0;
    let totalErrors = 0;
    try {
      for (let i = 0; i < STAGES.length; i++) {
        setStageIndex(i);
        const result = await runOne(STAGES[i].url);
        totalSignals += result.signalCount;
        totalErrors += result.errorCount;
        router.refresh();
      }
      setStatus("idle");
      setMessage(
        `Done — ${totalSignals} stock${totalSignals === 1 ? "" : "s"} tracked` +
          (totalErrors > 0 ? `, ${totalErrors} lookup${totalErrors === 1 ? "" : "s"} failed (some data may be missing).` : ".")
      );
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
