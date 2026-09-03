import { Redis } from "@upstash/redis";
import type { SmaPoint } from "@/lib/strategy";
import type { GapInfo } from "@/lib/gaps";
import type { VolumeSpikeCheck } from "@/lib/volumeSpike";
import type { WaveTrendCheck } from "@/lib/waveTrend";

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
  // Optional, not just newly-added: Redis holds whatever the last daily-cron
  // run wrote, so a signal can still be the stale output of a run from
  // before this field existed, until the next run overwrites it. Any reader
  // must treat a missing value as "no spike data", not assume it's always
  // present just because StrategySignal always sets it going forward.
  volumeSpike?: VolumeSpikeCheck;
  // Same staleness caveat as volumeSpike above — optional, not just
  // newly-added.
  waveTrend?: WaveTrendCheck;
  // Nearest still-unfilled real (non-Heikin-Ashi) price gap within 20% of
  // entryPrice — see findNextGap in lib/gaps.ts. Purely informational: it
  // plays no part in which stocks make the strategy's own signal list, only
  // computed for 1D (null for 4H, which has no raw daily candles fetched
  // during that pass to compute it from).
  nextGap: GapInfo | null;
};

export type LatestSignals = { date: string; runAt: string; signals: StoredSignal[] };

// The full F&O stock list (every symbol, no pre-filtering — see
// runDailyStrategy.ts) is split into this many slices for the Daily pass
// (see partitionForBatch), each running as its own scheduled/manual
// invocation so none of them individually exceeds Vercel Hobby's 60s
// function-duration cap. The 4H pass only ever uses batch "A" now (it's
// index-only — 5 symbols, no batching needed), but shares this same
// BatchId type/key scheme rather than a separate one.
export const BATCH_IDS = ["A", "B", "C"] as const;
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

// One step in a trade's own capital-required-over-time ledger — a new
// entry is appended whenever the trade's capitalRequired actually changes
// (open, add, partial/full close), so lib/performance.ts can reconstruct
// how much capital was tied up across the WHOLE portfolio at any point in
// time, not just how much a given month's closed events happened to
// release. 0 once the trade is fully closed (all capital freed).
export type CapitalSnapshot = { at: string; capitalRequired: number };

// One partial (or the final, fully-closing) realization event on a
// position — a position can be trimmed more than once over its life, each
// trim its own realized P&L, so this is an array on the trade rather than a
// single exit.
export type ClosedLot = {
  lots: number;
  exitPremium: number; // net premium at the time of this close, per share/unit
  exitUnderlyingPrice: number;
  closedAt: string; // ISO timestamp
  // This event's share of the position's capitalRequired at the moment it
  // was closed, scaled proportionally by lots (capital is treated as
  // roughly linear per lot for the same contract, which margin genuinely
  // is) — null if capital wasn't known at that point.
  capitalReleased: number | null;
  pnl: number; // realized ₹ for just this closed portion — precomputed and stored so Performance doesn't need to re-derive mode-based sign logic per event
};

export type PaperTrade = {
  id: string;
  symbol: string;
  direction: "short" | "long"; // from the underlying Strategy-tab signal
  mode: "buy" | "sell"; // naked ATM buying, or an OTM credit spread
  expiry: string;
  tradingSessionsUntilExpiryAtEntry: number;
  shortLeg: PaperTradeLeg; // the only leg in "buy" mode; the sold leg in "sell" mode
  longLeg: PaperTradeLeg | null; // protective leg, "sell" mode only
  lots: number; // CURRENTLY open lots — 0 once fully closed, reduced by a partial close, increased by adding to the position
  lotSize: number;
  entryAt: string; // ISO timestamp of the ORIGINAL entry (unchanged by later top-ups)
  entryUnderlyingPrice: number; // underlying price at the original entry (unchanged by later top-ups)
  entryPremium: number; // per share/unit, net of both legs if a spread — weighted average across whatever's currently open, if the position was added to since first opened
  // Capital tied up by the CURRENTLY OPEN lots, total ₹ (already scaled by
  // lots * lotSize) — for "buy" this is just the premium paid, always
  // known; for "sell" it's the real hedge-aware margin Kite's basket-margin
  // endpoint would actually require. Recomputed fresh whenever lots changes
  // (opened, added to, or partially closed), so it always reflects the
  // CURRENT open size — not frozen at the original entry the way it was
  // before partial closes/top-ups existed. Null only if that margin lookup
  // failed — the position still opens/adjusts, it's just excluded from the
  // capital-deployed total until known.
  capitalRequired: number | null;
  status: "open" | "closed"; // "closed" once lots reaches 0
  closedLots: ClosedLot[]; // history of every partial/full close, oldest first — empty if never closed at all
  lastMarkPremium: number | null; // most recent Live-button mark-to-market, per share/unit
  lastMarkAt: string | null;
  // Today's ₹ move as of the last Live press — see computeTodayPnl in
  // lib/paperTrading.ts — distinct from the position's whole-life P&L
  // (entryPremium vs. lastMarkPremium). Null until the first Live press
  // after this field existed, or if that day-change couldn't be computed
  // (e.g. a leg's quote was momentarily unavailable).
  todayPnl: number | null;
  // The underlying stock/index's own current price and day change, as of
  // the last Live press (or trade entry, for currentUnderlyingPrice only —
  // see markToMarket in lib/paperTrading.ts). Distinct from todayPnl above:
  // this is "how is the stock doing today," independent of which way the
  // option position is betting. underlyingChange* are null until the first
  // Live press, since computing a day change needs a live quote's previous
  // close, not just the entry-time spot price.
  currentUnderlyingPrice: number | null;
  underlyingChangeValue: number | null;
  underlyingChangePercent: number | null;
  // See CapitalSnapshot above. Always has at least one entry once a trade
  // has ever had a known capitalRequired; stays empty if capital was never
  // known at any point (e.g. every margin lookup for this trade failed),
  // which lib/performance.ts's timeline treats as "no capital contribution
  // from this trade" rather than guessing.
  capitalHistory: CapitalSnapshot[];
};

const PAPER_TRADES_KEY = "papertrades:all";

// A trade record as it may actually be shaped in Redis right now — includes
// fields from schema versions before closedLots existed, so getPaperTrades
// can migrate them on read rather than the app crashing or silently
// dropping history.
type StoredPaperTradeShape = Omit<
  PaperTrade,
  | "closedLots"
  | "capitalRequired"
  | "todayPnl"
  | "currentUnderlyingPrice"
  | "underlyingChangeValue"
  | "underlyingChangePercent"
  | "capitalHistory"
> & {
  capitalRequired?: number | null;
  todayPnl?: number | null;
  currentUnderlyingPrice?: number | null;
  underlyingChangeValue?: number | null;
  underlyingChangePercent?: number | null;
  capitalHistory?: CapitalSnapshot[];
  closedLots?: ClosedLot[];
  // Pre-partial-close schema: a single top-level exit instead of an array.
  exitAt?: string | null;
  exitUnderlyingPrice?: number | null;
  exitPremium?: number | null;
};

/**
 * Best-effort capitalHistory for a trade that predates this field —
 * there's no real record of how its capital level changed over time, so
 * this approximates it as constant for the trade's whole open life: the
 * current known capitalRequired if still open, or the total capital ever
 * released across its closedLots if fully closed (with a closing 0 entry
 * at its last close). Slightly overstates a topped-up-then-trimmed old
 * trade's true footprint at any given moment, but it's the only data
 * available for records written before capital changes were logged —
 * every trade going forward gets an exact step-by-step history instead.
 */
function synthesizeCapitalHistory(
  t: Pick<StoredPaperTradeShape, "entryAt" | "status" | "lots">,
  closedLots: ClosedLot[],
  currentCapitalRequired: number | null
): CapitalSnapshot[] {
  const isFullyClosed = t.status === "closed" || t.lots <= 0;
  const everReleased = closedLots.reduce((sum, lot) => sum + (typeof lot.capitalReleased === "number" ? lot.capitalReleased : 0), 0);
  const openingCapital = isFullyClosed ? everReleased : (currentCapitalRequired ?? 0);
  if (openingCapital <= 0) return [];

  const history: CapitalSnapshot[] = [{ at: t.entryAt, capitalRequired: openingCapital }];
  if (isFullyClosed) {
    const lastClosedAt = closedLots.length > 0 ? closedLots[closedLots.length - 1].closedAt : t.entryAt;
    history.push({ at: lastClosedAt, capitalRequired: 0 });
  }
  return history;
}

// Stored as one JSON array under a single key — manual entry/exit only
// (no automated writer), so volume stays low enough that this doesn't need
// the per-batch key sharding the signals cache uses.
export async function getPaperTrades(): Promise<PaperTrade[]> {
  const raw = (await getRedis().get<StoredPaperTradeShape[]>(PAPER_TRADES_KEY)) ?? [];
  return raw.map((t): PaperTrade => {
    const capitalRequired = t.capitalRequired ?? null;

    if (Array.isArray(t.closedLots)) {
      return {
        ...t,
        capitalRequired,
        closedLots: t.closedLots,
        lastMarkPremium: t.lastMarkPremium ?? null,
        lastMarkAt: t.lastMarkAt ?? null,
        todayPnl: t.todayPnl ?? null,
        currentUnderlyingPrice: t.currentUnderlyingPrice ?? null,
        underlyingChangeValue: t.underlyingChangeValue ?? null,
        underlyingChangePercent: t.underlyingChangePercent ?? null,
        capitalHistory:
          Array.isArray(t.capitalHistory) && t.capitalHistory.length > 0
            ? t.capitalHistory
            : synthesizeCapitalHistory(t, t.closedLots, capitalRequired),
      };
    }

    // Pre-partial-close record: migrate a legacy single top-level exit
    // (if any) into a one-entry closedLots history. Old records never
    // reduced `lots` on close, so a legacy-closed trade's `lots` here is
    // still the full original size — the closed portion IS the whole
    // position, and it now has zero lots open.
    const hasLegacyExit = typeof t.exitAt === "string" && typeof t.exitPremium === "number";
    const closedLots: ClosedLot[] = hasLegacyExit
      ? [
          {
            lots: t.lots,
            exitPremium: t.exitPremium as number,
            exitUnderlyingPrice: t.exitUnderlyingPrice ?? t.entryUnderlyingPrice,
            closedAt: t.exitAt as string,
            capitalReleased: capitalRequired,
            pnl:
              (t.mode === "buy" ? (t.exitPremium as number) - t.entryPremium : t.entryPremium - (t.exitPremium as number)) *
              t.lots *
              t.lotSize,
          },
        ]
      : [];

    return {
      id: t.id,
      symbol: t.symbol,
      direction: t.direction,
      mode: t.mode,
      expiry: t.expiry,
      tradingSessionsUntilExpiryAtEntry: t.tradingSessionsUntilExpiryAtEntry,
      shortLeg: t.shortLeg,
      longLeg: t.longLeg,
      lots: hasLegacyExit ? 0 : t.lots,
      lotSize: t.lotSize,
      entryAt: t.entryAt,
      entryUnderlyingPrice: t.entryUnderlyingPrice,
      entryPremium: t.entryPremium,
      capitalRequired: hasLegacyExit ? null : capitalRequired,
      status: t.status,
      closedLots,
      lastMarkPremium: t.lastMarkPremium ?? null,
      lastMarkAt: t.lastMarkAt ?? null,
      todayPnl: t.todayPnl ?? null,
      currentUnderlyingPrice: t.currentUnderlyingPrice ?? null,
      underlyingChangeValue: t.underlyingChangeValue ?? null,
      underlyingChangePercent: t.underlyingChangePercent ?? null,
      capitalHistory:
        Array.isArray(t.capitalHistory) && t.capitalHistory.length > 0
          ? t.capitalHistory
          : synthesizeCapitalHistory(
              { entryAt: t.entryAt, status: hasLegacyExit ? "closed" : t.status, lots: hasLegacyExit ? 0 : t.lots },
              closedLots,
              hasLegacyExit ? null : capitalRequired
            ),
    };
  });
}

export async function savePaperTrades(trades: PaperTrade[]): Promise<void> {
  await getRedis().set(PAPER_TRADES_KEY, trades);
}

const CAPITAL_BASE_KEY = "papertrades:capitalBase";
const DEFAULT_CAPITAL_BASE = 5_000_000; // ₹50 lakh — the starting paper-trading capital base

/**
 * The capital base paper-trading performance is measured against — a
 * "return on capital deployed" (per trade/month) doesn't need one, but a
 * portfolio-level return (this month's P&L as a % of your whole book, not
 * just whatever you happened to have in the market) does. Defaults to ₹50
 * lakh with no explicit setup needed; editable later (Performance tab)
 * since a "starting" base is exactly that — a starting point, not
 * necessarily permanent.
 */
export async function getCapitalBase(): Promise<number> {
  const v = await getRedis().get<number>(CAPITAL_BASE_KEY);
  return typeof v === "number" && v > 0 ? v : DEFAULT_CAPITAL_BASE;
}

export async function setCapitalBase(amount: number): Promise<void> {
  await getRedis().set(CAPITAL_BASE_KEY, amount);
}
