# OPSELL

A mobile web app for browsing NSE F&O (futures & options) stocks and their live option chains, using your Zerodha account as the data source. It's built to be added to your iPhone home screen so it behaves like a regular app, no App Store needed.

**Where things stand right now:** you can log in with Zerodha and see the F&O scanner — every NSE stock with listed futures & options, split into **Liquid** and **Illiquid** tabs, plus an **Indices** tab for Nifty, Bank Nifty, Fin Nifty, Midcap Nifty, and Sensex. Tapping a stock opens its live option chain (strikes, LTP, open interest) for any expiry. The **Strategy** tab shows short/long signals from a Supertrend + SMA crossover strategy, computed automatically every trading day after market close.

**How Liquid vs. Illiquid is decided:** each stock's near-month futures contract has an open interest and a today's-volume number from Zerodha. Both are ranked against every other F&O stock (as a percentile, 0–100), the two ranks are averaged into one score, and stocks scoring above the market's median go in Liquid, the rest in Illiquid. It's computed fresh from live quotes on every page load — no separate database or background job.

**How the daily Strategy signals work:** every trading day, two scheduled jobs — one at 4:00 PM IST for Daily, one at 4:10 PM IST for 4H — fetch historical price data, convert it to Heikin Ashi candles, and check, per stock/index, every adjacent pair in SMA20/50/100/200 (SMA10 is excluded — too close to price, too noisy). Supertrend(14,1) and every SMA are computed on the Heikin Ashi series, not the real candles — this matches how TradingView actually plots them: when a chart's candle type is set to Heikin Ashi, its built-in Supertrend/MA scripts read the HA-transformed open/high/low/close, not the real market prices, unless a script deliberately re-requests raw data. (Earlier versions of this app computed both on real OHLC, which is the textbook-standard way to run Supertrend, but caused a persistent ~5-20 point mismatch against the reference TradingView chart — switching to HA-based calculation closed that gap.) A **short** signal needs all of: Supertrend is in an uptrend, the Heikin Ashi candle close is still above the Supertrend line, one SMA just crossed from at/below the line to above it, and the *next* SMA out (its target — e.g. SMA50 for a SMA20 cross) is still below the line, meaning only the faster average has caught up so far. The mirror image — Supertrend downtrend, HA close below the line, an SMA crossing from at/above to below it, target SMA still above the line — is a **long** signal. Only the entry price uses the real (non-HA) close, since that's what's actually tradeable. Both timeframes cover the same universe: the top 120 F&O stocks by liquidity score (the same OI+volume ranking behind the Liquid/Illiquid split), spot/equity price, plus all 5 indices. The Strategy tab shows Daily and 4H results in two separate sections. (Stocks and indices, and Daily and 4H, all used to run in one function call; the full combination was well over Vercel Hobby's hard 60-second function-duration cap, so Daily and 4H are now two separate scheduled jobs — see `lib/runDailyStrategy.ts` and the two routes under `app/api/cron/`. The full ~185-stock F&O universe was also tried before capping to the top 120 by liquidity — even Daily alone took ~62 seconds against that stock count, over budget on its own.) (A near-month futures version was tried and reverted — Kite's `continuous=1` futures data is a raw, non-back-adjusted concatenation of monthly contracts, so it carries a real price gap at every rollover; over a 500-day lookback that's compounded across ~16 gaps badly enough to corrupt the ATR/Supertrend math. Spot doesn't have that problem, at the cost of an occasional small Kite-vs-other-data-provider discrepancy on a still-settling candle, which `lib/candleFreshness.ts` mitigates by using the live quote for today's bar.) The app only surfaces short/long calls — turning a signal into an actual option trade (strike, expiry, buy vs. sell) is left to you. You can also trigger both passes on demand anytime from the **Run strategy now** button on the Strategy tab, instead of waiting for the scheduled jobs.

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

The jobs themselves are already scheduled (see `vercel.json`) — Daily at 4:00 PM IST, 4H at 4:10 PM IST, Monday–Friday. You do need to have tapped **Connect to Zerodha** in the app at some point earlier that same day, since Zerodha's login tokens expire daily and the scheduled jobs re-use whatever session you last logged into.

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

## Notes for whoever maintains this later

- Built with Next.js 14 (App Router) + TypeScript + Tailwind CSS.
- Talks to Kite Connect directly over `fetch` (no third-party Kite SDK), to avoid pulling in that SDK's outdated, vulnerable transitive dependencies.
- The instrument dump is cached in memory per server process for 6 hours; on serverless hosts each cold start refetches it once.
- `lib/indicators.ts` / `lib/strategy.ts` hold the Supertrend + SMA math and crossover detection, kept as pure functions over candle arrays — no I/O, easy to unit test in isolation.
- `lib/runDailyStrategy.ts` exports two independent functions, `runDailyTimeframeStrategy()` and `run4HTimeframeStrategy()`, each shared between its own cron route (`app/api/cron/daily-strategy` / `-4h`) and its own manual endpoint (`app/api/strategy/run` / `run-4h`) behind the Strategy tab's button. Both are rate-limited to Kite's 3 req/sec historical-data cap in batches of 3, and both scan the top `TOP_N_STOCKS_BY_LIQUIDITY` (120) F&O stocks by liquidity score rather than the full universe. Each checkpoint-saves after its stocks phase so an indices-phase timeout doesn't lose that pass's run. `maxDuration` is set to 300s on each route, but Vercel's Hobby plan hard-caps actual function duration at 60s regardless — which is exactly why Daily and 4H are two separate invocations instead of one combined run; upgrading to Pro removes that cap (at which point they could be merged back into one job, and/or `TOP_N_STOCKS_BY_LIQUIDITY` raised or dropped). `lib/kv.ts`'s `saveSignalsForTimeframe()` replaces only its own timeframe's slice of the day's stored signals on each save, so the two passes (which may run minutes apart, in separate function invocations with no shared memory) don't clobber each other.
- `package.json` doesn't pin `package-lock.json` — it's regenerated deterministically by `npm install`.
- `app/strategy/page.tsx` reads whatever the daily job last stored; it doesn't compute anything itself.
