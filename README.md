# OPSELL

A mobile web app for browsing NSE F&O (futures & options) stocks and their live option chains, using your Zerodha account as the data source. It's built to be added to your iPhone home screen so it behaves like a regular app, no App Store needed.

**Where things stand right now:** you can log in with Zerodha and see the F&O scanner — every NSE stock with listed futures & options, split into **Liquid** and **Illiquid** tabs, plus an **Indices** tab for Nifty, Bank Nifty, Fin Nifty, Midcap Nifty, and Sensex. Tapping a stock opens its live option chain (strikes, LTP, open interest) for any expiry. The **Strategy** tab shows Short/Super Short/Long/Super Long signals from a Supertrend + SMA crossover strategy, in two side-by-side Daily and 4H columns, computed automatically every trading day after market close. The **Positions** tab shows your currently open positions straight from Zerodha (symbol, product, quantity, average price, LTP, live P&L) — this is a read-only mirror of your actual account, not something the app tracks itself.

**How Liquid vs. Illiquid is decided:** each stock's near-month futures contract has an open interest and a today's-volume number from Zerodha. Both are ranked against every other F&O stock (as a percentile, 0–100), the two ranks are averaged into one score, and stocks scoring above the market's median go in Liquid, the rest in Illiquid. It's computed fresh from live quotes on every page load — no separate database or background job.

**How the daily Strategy signals work:** every trading day, four scheduled jobs — Daily at 4:00 and 4:05 PM IST, 4H at 4:10 and 4:15 PM IST — together fetch historical price data for the **full NSE F&O stock list** plus all 5 indices, convert it to Heikin Ashi candles, and check, per stock/index, every adjacent pair in SMA20/50/100/200 (SMA10 is excluded — too close to price, too noisy). Supertrend(14,1) and every SMA are computed on the Heikin Ashi series, not the real candles — this matches how TradingView actually plots them: when a chart's candle type is set to Heikin Ashi, its built-in Supertrend/MA scripts read the HA-transformed open/high/low/close, not the real market prices, unless a script deliberately re-requests raw data. (Earlier versions of this app computed both on real OHLC, which is the textbook-standard way to run Supertrend, but caused a persistent ~5-20 point mismatch against the reference TradingView chart — switching to HA-based calculation closed that gap.) A **short** signal needs all of: Supertrend is in an uptrend, the Heikin Ashi candle close is still above the Supertrend line, one SMA just crossed from at/below the line to above it, and the *next* SMA out (its target — e.g. SMA50 for a SMA20 cross) is still below the line, meaning only the faster average has caught up so far. The mirror image — Supertrend downtrend, HA close below the line, an SMA crossing from at/above to below it, target SMA still above the line — is a **long** signal. Only the entry price uses the real (non-HA) close, since that's what's actually tradeable. A crossing SMA20 is labeled **Short**/**Long**; a crossing SMA50 or SMA100 (the faster average having already caught up to a slower one) is labeled **Super Short**/**Super Long**. The Strategy tab shows just that label, the entry price, and the target price, in two side-by-side Daily and 4H columns — no timestamps or raw Supertrend/SMA numbers, those live in the debug endpoint instead (see below).

Four jobs, not one, because of a Vercel Hobby constraint: a function hard-caps at 60 seconds regardless of the `maxDuration` code setting, and at Kite's 3-requests/second historical-data limit, fetching the full ~185-stock F&O universe for one timeframe alone takes ~62 seconds — over budget on its own, before indices or Daily+4H are even considered. So the full stock list is split into 2 alphabetical batches (`BATCH_IDS` in `lib/kv.ts`), and each (batch × timeframe) combination is a separate job — 2 batches × 2 timeframes = 4 — so every individual invocation finishes in well under 60 seconds while the four together still cover everything. The 5 indices ride along with the first batch of each timeframe only, so they aren't fetched twice. See `lib/runDailyStrategy.ts` for the batching/partition logic and `lib/kv.ts` for how each batch's results are stored under their own key and merged into one combined view for the Strategy tab to read. (A near-month futures version was tried and reverted — Kite's `continuous=1` futures data is a raw, non-back-adjusted concatenation of monthly contracts, so it carries a real price gap at every rollover; over a 500-day lookback that's compounded across ~16 gaps badly enough to corrupt the ATR/Supertrend math. Spot doesn't have that problem, at the cost of an occasional small Kite-vs-other-data-provider discrepancy on a still-settling candle, which `lib/candleFreshness.ts` mitigates by using the live quote for today's bar.) The app only surfaces short/long calls — turning a signal into an actual option trade (strike, expiry, buy vs. sell) is left to you. You can also trigger all four passes on demand anytime from the **Run strategy now** button on the Strategy tab (it runs them one after another, since they share Kite's rate limit — expect a few minutes total), instead of waiting for the scheduled jobs.

## 1. Get a Zerodha Kite Connect API key

This app needs its own API key to talk to your Zerodha account (this is separate from your regular login).

1. Go to <https://developers.kite.trade/apps> and log in with your Zerodha credentials.
2. Click **Create new app**, choose **Connect** as the type, and give it any name (e.g. "OPSELL").
3. For **Redirect URL**, enter: `https://YOUR-DEPLOYED-URL/api/kite/callback` (you'll get the real URL in step 2 below — you can come back and fill this in afterwards).
4. Kite Connect is a paid API (Zerodha charges a small monthly fee for it, shown on that page) — you'll need to subscribe to use it.
5. Once created, you'll see an **API key** and **API secret**. You'll need both in the next step.

## 2. Deploy the app (no coding required)

The easiest way is [Vercel](https://vercel.com), which is free for personal projects:

1. Sign up at vercel.com (you can sign in with your GitHub account).
2. Click **Add New → Project**, and import this repository.
3. Before deploying, open **Environment Variables** and add:
   - `KITE_API_KEY` — from step 1
   - `KITE_API_SECRET` — from step 1
4. Click **Deploy**. Vercel will give you a URL like `https://opsell-yourname.vercel.app`.
5. Go back to your Kite Connect app settings (step 1) and set the **Redirect URL** to `https://opsell-yourname.vercel.app/api/kite/callback`.

## 3. Connect storage for the daily Strategy job (one-time)

The 4 PM daily routine runs as a scheduled job with no browser attached, so it needs its own small storage to (a) remember you're logged in and (b) save the day's signals for the Strategy tab to show. This is a couple of clicks, no coding:

1. In your Vercel project, go to the **Storage** tab and add a **Redis** database (search the Marketplace for "Redis" if it's not shown directly — it's provided by Upstash and free at this scale).
2. Connect it to this project when prompted — Vercel will automatically add the required environment variables for you (no copying/pasting keys needed for this one).
3. Go to **Settings → Environment Variables** and add one more variable yourself: `CRON_SECRET`, with any random string as the value (this stops strangers from triggering your daily job). A quick way to generate one: run `openssl rand -hex 32` on a Mac/Linux terminal, or just mash the keyboard for 30+ random characters.
4. Redeploy (Deployments tab → latest deployment → **⋯** → Redeploy) so the new variables take effect.

The jobs themselves are already scheduled (see `vercel.json`) — Daily at 4:00 and 4:05 PM IST, 4H at 4:10 and 4:15 PM IST, Monday–Friday. You do need to have tapped **Connect to Zerodha** in the app at some point earlier that same day, since Zerodha's login tokens expire daily and the scheduled jobs re-use whatever session you last logged into.

## 4. Add it to your iPhone home screen

1. Open your deployed URL in **Safari** on your iPhone (must be Safari, not Chrome).
2. Tap the **Share** icon (square with an arrow) in the toolbar.
3. Tap **Add to Home Screen**.

It'll now open full-screen from your home screen like a normal app.

## 5. Using it day to day

- Open the app and tap **Connect to Zerodha** on the Settings tab, then log in with your Zerodha credentials.
- Zerodha access tokens expire every day (usually overnight), so you'll need to tap **Connect to Zerodha** again each trading day — ideally before 4 PM, so the daily Strategy job has a valid session to use.
- Browse F&O stocks and tap one to see its option chain for the nearest expiry (you can switch expiries from the dropdown).
- Check the **Strategy** tab after market close for that day's short/long signals.
- Check the **Positions** tab anytime to see what's currently open in your Zerodha account.

## Notes for whoever maintains this later

- Built with Next.js 14 (App Router) + TypeScript + Tailwind CSS.
- Talks to Kite Connect directly over `fetch` (no third-party Kite SDK), to avoid pulling in that SDK's outdated, vulnerable transitive dependencies.
- The instrument dump is cached in memory per server process for 6 hours; on serverless hosts each cold start refetches it once.
- `lib/indicators.ts` / `lib/strategy.ts` hold the Supertrend + SMA math and crossover detection, kept as pure functions over candle arrays — no I/O, easy to unit test in isolation.
- `lib/runDailyStrategy.ts` exports two independent functions, `runDailyTimeframeStrategy(accessToken, batchId)` and `run4HTimeframeStrategy(accessToken, batchId)`, each taking a `batchId` ("A" or "B" — see `BATCH_IDS` in `lib/kv.ts`) that selects which alphabetical slice of the full F&O stock list to process (`partitionForBatch`). Each is shared between its own cron route (`app/api/cron/daily-strategy` / `-4h`, both reading `?batch=` from the query string) and its own manual endpoint (`app/api/strategy/run` / `run-4h`, same query param) behind the Strategy tab's button. All four (batch × timeframe) combinations are rate-limited to Kite's 3 req/sec historical-data cap in batches of 3 and checkpoint-save after their stocks phase so an indices-phase timeout doesn't lose that invocation's run; indices only run alongside batch "A". `maxDuration` is set to 300s on each route, but Vercel's Hobby plan hard-caps actual function duration at 60s regardless — which is exactly why the work is split into 4 invocations instead of 1 or 2; upgrading to Pro removes that cap (at which point `BATCH_IDS` could shrink back to a single batch). `lib/kv.ts`'s `saveSignalBatch()` writes each (date, timeframe, batchId) combination to its own Redis key and republishes a merged view across all of them, so batches that run minutes apart in separate function invocations with no shared memory can't clobber each other.
- `package.json` doesn't pin `package-lock.json` — it's regenerated deterministically by `npm install`.
- `app/strategy/page.tsx` reads whatever the daily job last stored; it doesn't compute anything itself.
