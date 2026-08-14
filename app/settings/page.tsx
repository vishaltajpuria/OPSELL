import { isConnected } from "@/lib/session";

export const dynamic = "force-dynamic";

export default function SettingsPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const connected = isConnected();
  const configured = Boolean(process.env.KITE_API_KEY && process.env.KITE_API_SECRET);

  return (
    <main className="px-4 pt-6">
      <h1 className="text-xl font-semibold">Settings</h1>
      <p className="mt-1 text-sm text-muted">Zerodha connection</p>

      {searchParams.error && (
        <p className="mt-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          {searchParams.error}
        </p>
      )}

      <div className="mt-4 rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${connected ? "bg-accent" : "bg-muted"}`} />
          <span className="text-sm font-medium">{connected ? "Connected" : "Not connected"}</span>
        </div>

        {!configured && (
          <p className="mt-3 text-sm text-muted">
            KITE_API_KEY / KITE_API_SECRET aren&apos;t set yet. Add them as environment variables
            (see README) before connecting.
          </p>
        )}

        <div className="mt-4">
          {connected ? (
            <a
              href="/api/kite/logout"
              className="inline-block w-full rounded-lg border border-border bg-surface2 px-4 py-2.5 text-center text-sm font-medium"
            >
              Disconnect
            </a>
          ) : (
            <a
              href="/api/kite/login"
              className={`inline-block w-full rounded-lg px-4 py-2.5 text-center text-sm font-medium ${
                configured ? "bg-accent text-black" : "pointer-events-none bg-surface2 text-muted"
              }`}
            >
              Connect to Zerodha
            </a>
          )}
        </div>
      </div>

      <p className="mt-4 text-xs text-muted">
        Zerodha access tokens expire daily, so you&apos;ll need to reconnect each trading day.
      </p>
    </main>
  );
}
