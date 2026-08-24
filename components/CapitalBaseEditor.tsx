"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

function fmt(n: number) {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

export default function CapitalBaseEditor({ capitalBase }: { capitalBase: number }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(String(capitalBase));
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const amount = Number(text);
    if (!Number.isFinite(amount) || amount <= 0) {
      setStatus("error");
      setError("Enter a positive number.");
      return;
    }
    setStatus("saving");
    try {
      const res = await fetch("/api/papertrade/capital", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capitalBase: amount }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save.");
      setEditing(false);
      setStatus("idle");
      router.refresh();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!editing) {
    return (
      <button
        onClick={() => {
          setText(String(capitalBase));
          setEditing(true);
          setStatus("idle");
          setError(null);
        }}
        className="text-[11px] text-muted underline decoration-dotted"
      >
        Capital base ₹{fmt(capitalBase)} · edit
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        inputMode="numeric"
        min="1"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-32 rounded-lg border border-border bg-surface2 p-1.5 text-xs text-foreground"
      />
      <button
        onClick={save}
        disabled={status === "saving"}
        className="rounded-lg bg-accent px-2.5 py-1.5 text-[11px] font-medium text-black disabled:opacity-50"
      >
        {status === "saving" ? "Saving…" : "Save"}
      </button>
      <button
        onClick={() => setEditing(false)}
        className="rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-medium"
      >
        Cancel
      </button>
      {status === "error" && <span className="text-[11px] text-danger">{error}</span>}
    </div>
  );
}
