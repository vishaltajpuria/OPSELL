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
    } catch {
      setStatus("error");
      setMessage("Failed to run the strategy — check your connection and try again.");
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
      {message && (
        <p className={`mt-2 text-xs ${status === "error" ? "text-danger" : "text-muted"}`}>{message}</p>
      )}
    </div>
  );
}
