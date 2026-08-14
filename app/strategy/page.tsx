export default function StrategyPage() {
  return (
    <main className="px-4 pt-6">
      <h1 className="text-xl font-semibold">Strategy</h1>
      <p className="mt-1 text-sm text-muted">AI-generated option-selling ideas</p>

      <div className="mt-6 rounded-xl border border-border bg-surface p-5 text-center">
        <p className="text-3xl">🤖</p>
        <p className="mt-3 text-sm text-muted">
          This tab will run an LLM routine over live F&amp;O data to suggest option-selling
          trades, once the strategy rules are defined.
        </p>
      </div>
    </main>
  );
}
