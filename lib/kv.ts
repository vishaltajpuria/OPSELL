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

// The full F&O stock list is split into this many slices (see
// partitionForBatch in runDailyStrategy.ts), each running as its own
// scheduled/manual invocation so none of them individually exceeds Vercel
// Hobby's 60s function-duration cap.
export const BATCH_IDS = ["A", "B"] as const;
export type BatchId = (typeof BATCH_IDS)[number];

type StoredBatchPayload = { signals: StoredSignal[]; savedAt: string };

function batchKey(dateKey: string, timeframe: StoredSignal["timeframe"], batchId: BatchId): string {
  return `signals:${dateKey}:${timeframe}:${batchId}`;
}

async function republishMerged(dateKey: string): Promise<void> {
  const redis = getRedis();
  const keys = (["1D", "4H"] as const).flatMap((tf) => BATCH_IDS.map((b) => batchKey(dateKey, tf, b)));
  const batches = await Promise.all(keys.map((k) => redis.get<StoredBatchPayload>(k)));
  const signals = batches.flatMap((b) => b?.signals ?? []);
  const payload: LatestSignals = { date: dateKey, runAt: new Date().toISOString(), signals };
  await redis.set(`signals:${dateKey}`, payload);
  await redis.set("signals:latest", payload);
}

/**
 * Each batch/timeframe invocation writes only to its own key — never
 * reading or rewriting another batch's or timeframe's data, so batches that
 * run minutes apart in separate serverless invocations can't clobber each
 * other. After writing, this republishes a merged view across every
 * batch/timeframe key for the day, so the Strategy tab (which just reads
 * "signals:latest") always sees the combined picture. Safe to call more
 * than once per invocation too (e.g. a stocks-phase checkpoint followed by
 * a final save that adds indices) since each call fully replaces its own
 * batch's slice.
 */
export async function saveSignalBatch(
  dateKey: string,
  timeframe: StoredSignal["timeframe"],
  batchId: BatchId,
  signals: StoredSignal[]
): Promise<void> {
  const redis = getRedis();
  const payload: StoredBatchPayload = { signals, savedAt: new Date().toISOString() };
  await redis.set(batchKey(dateKey, timeframe, batchId), payload);
  await republishMerged(dateKey);
}

export async function getLatestSignals(): Promise<LatestSignals | null> {
  return (await getRedis().get<LatestSignals>("signals:latest")) ?? null;
}

export type PaperTradeLeg = { tradingsymbol: string; strike: number; optionType: "CE" | "PE" };

export type PaperTrade = {
  id: string;
  symbol: string;
  direction: "short" | "long"; // from the underlying Strategy-tab signal
  mode: "buy" | "sell"; // naked ATM buying, or an OTM credit spread
  expiry: string;
  tradingSessionsUntilExpiryAtEntry: number;
  shortLeg: PaperTradeLeg; // the only leg in "buy" mode; the sold leg in "sell" mode
  longLeg: PaperTradeLeg | null; // protective leg, "sell" mode only
  lots: number;
  lotSize: number;
  entryAt: string; // ISO timestamp
  entryUnderlyingPrice: number;
  entryPremium: number; // per share/unit — net of both legs if a spread
  // Capital tied up by this position, total ₹ (already scaled by lots *
  // lotSize) — for "buy" this is just the premium paid, always known; for
  // "sell" it's the real hedge-aware margin Kite's basket-margin endpoint
  // would actually require, computed once at entry (not re-fetched by the
  // Live button, so it stays a stable denominator for a return-on-capital
  // calculation over the life of the trade). Null only if that margin
  // lookup failed at entry time — the trade still opens, this position is
  // just excluded from the capital-deployed total until you know it.
  capitalRequired: number | null;
  status: "open" | "closed";
  exitAt: string | null;
  exitUnderlyingPrice: number | null;
  exitPremium: number | null;
  lastMarkPremium: number | null; // most recent Live-button mark-to-market, per share/unit
  lastMarkAt: string | null;
};

const PAPER_TRADES_KEY = "papertrades:all";

// Stored as one JSON array under a single key — manual entry/exit only
// (no automated writer), so volume stays low enough that this doesn't need
// the per-batch key sharding the signals cache uses.
export async function getPaperTrades(): Promise<PaperTrade[]> {
  return (await getRedis().get<PaperTrade[]>(PAPER_TRADES_KEY)) ?? [];
}

export async function savePaperTrades(trades: PaperTrade[]): Promise<void> {
  await getRedis().set(PAPER_TRADES_KEY, trades);
}
