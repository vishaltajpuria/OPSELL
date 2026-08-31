"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Covers the full F&O stock list on Daily (3 batches, A/B/C — no
// pre-filtering) plus indices on both Daily and 4H (folded into batch A of
// each). Run sequentially as separate requests rather than one big call,
// since each needs its own Vercel Hobby 60s budget and they share Kite's
// 3 req/sec historical-data limit (running them in parallel would just hit
// rate limits, not finish any faster).
const STAGES = [
  { label: "Daily (1 of 4)", url: "/api/strategy/run?batch=A" },
  { label: "Daily (2 of 4)", url: "/api/strategy/run?batch=B" },
  { label: "Daily (3 of 4)", url: "/api/strategy/run?batch=C" },
  { label: "4H indices (4 of 4)", url: "/api/strategy/run-4h?batch=A" },
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

export default function RunStrategyButton() {
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
      setMessage(`Done — ${totalSignals} signal${totalSignals === 1 ? "" : "s"} found across Daily + 4H.`);
    } catch (err) {
      setStatus("error");
      // A run can genuinely still finish on the server even if the phone's
      // connection drops mid-wait (screen lock, app backgrounded, etc.) — so
      // refresh regardless and let the "Last run" timestamp be the source of
      // truth, rather than trusting this error alone.
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
          Covers the full F&amp;O list in 4 stages and can take a few minutes total — keep this screen open and
          your phone unlocked.
        </p>
      )}
      {message && (
        <p className={`mt-2 text-xs ${status === "error" ? "text-danger" : "text-muted"}`}>{message}</p>
      )}
    </div>
  );
}
