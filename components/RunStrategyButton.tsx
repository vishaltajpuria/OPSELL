"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Status = "idle" | "running" | "error";

export default function RunStrategyButton() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setStatus("running");
    setMessage(null);
    try {
      const res = await fetch("/api/strategy/run", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Failed to run the strategy.");
        return;
      }
      setStatus("idle");
      setMessage(`Done — ${data.signalCount} signal${data.signalCount === 1 ? "" : "s"} found.`);
      router.refresh();
    } catch (err) {
      setStatus("error");
      // The run can genuinely still finish on the server even if the phone's
      // connection drops mid-wait (screen lock, app backgrounded, etc.) — so
      // refresh regardless and let the "Last run" timestamp be the source of
      // truth, rather than trusting this error alone.
      const detail = err instanceof Error ? err.message : String(err);
      setMessage(
        `Lost connection while waiting (${detail}). Check the "Last run" time below — it may have finished anyway.`
      );
      router.refresh();
    }
  }

  return (
    <div className="mb-4">
      <button
        onClick={run}
        disabled={status === "running"}
        className="w-full rounded-xl bg-accent px-4 py-3 text-center text-sm font-medium text-black disabled:opacity-60"
      >
        {status === "running" ? "Running… this can take up to a minute" : "Run strategy now"}
      </button>
      {status === "running" && (
        <p className="mt-2 text-xs text-muted">Keep this screen open and your phone unlocked until it finishes.</p>
      )}
      {message && (
        <p className={`mt-2 text-xs ${status === "error" ? "text-danger" : "text-muted"}`}>{message}</p>
      )}
    </div>
  );
}
