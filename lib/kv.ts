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
  targetSma: SmaPoint | null;
};

export type LatestSignals = { date: string; signals: StoredSignal[] };

export async function saveDailySignals(dateKey: string, signals: StoredSignal[]): Promise<void> {
  const payload: LatestSignals = { date: dateKey, signals };
  const redis = getRedis();
  await redis.set(`signals:${dateKey}`, payload);
  await redis.set("signals:latest", payload);
}

export async function getLatestSignals(): Promise<LatestSignals | null> {
  return (await getRedis().get<LatestSignals>("signals:latest")) ?? null;
}
