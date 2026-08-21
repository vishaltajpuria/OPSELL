"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Status = "idle" | "running-daily" | "running-4h" | "error";

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
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setMessage(null);
    try {
      // Run sequentially, not in parallel: both hit Kite's shared 3 req/sec
      // historical-data limit, so running them at once would just cause
      // rate-limit errors instead of finishing any faster.
      setStatus("running-daily");
      const daily = await runOne("/api/strategy/run");
      router.refresh();

      setStatus("running-4h");
      const fourHour = await runOne("/api/strategy/run-4h");
      router.refresh();

      setStatus("idle");
      setMessage(`Done — ${daily.signalCount} Daily signal${daily.signalCount === 1 ? "" : "s"}, ${fourHour.signalCount} 4H signal${fourHour.signalCount === 1 ? "" : "s"}.`);
    } catch (err) {
      setStatus("error");
      // A run can genuinely still finish on the server even if the phone's
      // connection drops mid-wait (screen lock, app backgrounded, etc.) — so
      // refresh regardless and let the "Last run" timestamp be the source of
      // truth, rather than trusting this error alone.
      const detail = err instanceof Error ? err.message : String(err);
      setMessage(
        `Lost connection while waiting (${detail}). Check the "Last run" times below — they may have finished anyway.`
      );
      router.refresh();
    }
  }

  const running = status === "running-daily" || status === "running-4h";

  return (
    <div className="mb-4">
      <button
        onClick={run}
        disabled={running}
        className="w-full rounded-xl bg-accent px-4 py-3 text-center text-sm font-medium text-black disabled:opacity-60"
      >
        {status === "running-daily" && "Running Daily… (1 of 2)"}
        {status === "running-4h" && "Running 4H… (2 of 2)"}
        {!running && "Run strategy now"}
      </button>
      {running && (
        <p className="mt-2 text-xs text-muted">
          Keep this screen open and your phone unlocked until it finishes — this runs two passes and can take a
          few minutes total.
        </p>
      )}
      {message && (
        <p className={`mt-2 text-xs ${status === "error" ? "text-danger" : "text-muted"}`}>{message}</p>
      )}
    </div>
  );
}
