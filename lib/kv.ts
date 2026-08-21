import { Redis } from "@upstash/redis";
import type { SmaPoint } from "@/lib/strategy";

let client: Redis | null = null;

// Vercel's Marketplace Redis (Upstash) integration injects either
// UPSTASH_REDIS_REST_URL/TOKEN or, depending on how the store was
// provisioned, KV_REST_API_URL/TOKEN — accept either rather than assuming one.
function getRedis(): Redis {
  if (client) return client;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Redis storage isn't connected yet — add a Redis store from the Vercel Marketplace (see README)."
    );
  }
  client = new Redis({ url, token });
  return client;
}

const ACCESS_TOKEN_KEY = "kite:access_token";
const ACCESS_TOKEN_TTL_SECONDS = 20 * 60 * 60; // matches the session cookie's lifetime

/**
 * The daily cron job has no browser session to read the Kite access token
 * from (it isn't triggered by a request carrying the session cookie), so the
 * token is mirrored here at login time for server-side jobs to use.
 */
export async function setStoredAccessToken(token: string): Promise<void> {
  await getRedis().set(ACCESS_TOKEN_KEY, token, { ex: ACCESS_TOKEN_TTL_SECONDS });
}

export async function getStoredAccessToken(): Promise<string | null> {
  return (await getRedis().get<string>(ACCESS_TOKEN_KEY)) ?? null;
}

export type StoredSignal = {
  symbol: string;
  timeframe: "1D" | "4H";
  direction: "short" | "long";
  signalDate: string;
  entryPrice: number;
  supertrendValue: number;
  triggerSma: SmaPoint;
  targetSma: SmaPoint;
};

export type LatestSignals = { date: string; runAt: string; signals: StoredSignal[] };

/**
 * The Daily and 4H timeframes run as separate function invocations (each
 * needs its own Vercel Hobby 60s budget — see runDailyStrategy.ts), so
 * saving can't just overwrite the whole day's signal list or one timeframe
 * would wipe out the other. Instead this replaces only the entries for the
 * given timeframe, keeping whatever the other timeframe's run already saved
 * for today. Safe to call more than once per run too (e.g. a stocks-phase
 * checkpoint followed by the final save) since each call fully replaces its
 * own timeframe's slice.
 */
export async function saveSignalsForTimeframe(
  dateKey: string,
  timeframe: StoredSignal["timeframe"],
  signals: StoredSignal[]
): Promise<void> {
  const redis = getRedis();
  const existing = await redis.get<LatestSignals>(`signals:${dateKey}`);
  const keptOtherTimeframes = (existing?.date === dateKey ? existing.signals : []).filter(
    (s) => s.timeframe !== timeframe
  );
  const payload: LatestSignals = {
    date: dateKey,
    runAt: new Date().toISOString(),
    signals: [...keptOtherTimeframes, ...signals],
  };
  await redis.set(`signals:${dateKey}`, payload);
  await redis.set("signals:latest", payload);
}

export async function getLatestSignals(): Promise<LatestSignals | null> {
  return (await getRedis().get<LatestSignals>("signals:latest")) ?? null;
}
