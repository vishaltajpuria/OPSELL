# OPSELL

A mobile web app for browsing NSE F&O (futures & options) stocks and their live option chains, using your Zerodha account as the data source. It's built to be added to your iPhone home screen so it behaves like a regular app, no App Store needed.

**Where things stand right now:** you can log in with Zerodha and see the F&O scanner — every NSE stock with listed futures & options, split into **Liquid** and **Illiquid** tabs, plus an **Indices** tab for Nifty, Bank Nifty, Fin Nifty, Midcap Nifty, and Sensex. Tapping a stock opens its live option chain (strikes, LTP, open interest) for any expiry. The **Strategy** tab shows short/long signals from a Supertrend + SMA crossover strategy, computed automatically every trading day after market close.

**How Liquid vs. Illiquid is decided:** each stock's near-month futures contract has an open interest and a today's-volume number from Zerodha. Both are ranked against every other F&O stock (as a percentile, 0–100), the two ranks are averaged into one score, and stocks scoring above the market's median go in Liquid, the rest in Illiquid. It's computed fresh from live quotes on every page load — no separate database or background job.

**How the daily Strategy signals work:** every trading day at 4:00 PM IST, a scheduled job fetches historical price data and checks, per stock/index, every adjacent pair in SMA20/50/100/200 (SMA10 is excluded — too close to price, too noisy). A **short** signal needs all of: Supertrend(14,1) is in an uptrend, the Heikin Ashi candle close is still above the Supertrend line, one SMA just crossed from at/below the line to above it, and the *next* SMA out (its target — e.g. SMA50 for a SMA20 cross) is still below the line, meaning only the faster average has caught up so far. The mirror image — Supertrend downtrend, HA close below the line, an SMA crossing from at/above to below it, target SMA still above the line — is a **long** signal. Stocks run on the Daily timeframe across every F&O stock's near-month **futures** contract (Liquid and Illiquid alike) — not the spot/equity price. Futures don't have equity's official weighted-average closing-price computation, which was the source of a real bug: Kite's historical endpoint disagreed with the live price by a few points for a still-settling equity candle, enough to flip a signal that shouldn't have flipped. One consequence: entry/target prices are futures prices, which trade at a small premium/discount ("basis") to spot — so they won't exactly match a stock's plain equity chart. The five indices still run on spot, on both Daily and 4H. The app only surfaces short/long calls — turning a signal into an actual option trade (strike, expiry, buy vs. sell) is left to you. You can also trigger a run on demand anytime from the **Run strategy now** button on the Strategy tab, instead of waiting for the 4 PM schedule.

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

The job itself is already scheduled (see `vercel.json`) to run at 4:00 PM IST, Monday–Friday. You do need to have tapped **Connect to Zerodha** in the app at some point earlier that same day, since Zerodha's login tokens expire daily and the scheduled job re-uses whatever session you last logged into.

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
- `lib/runDailyStrategy.ts` holds the actual run logic (shared by the cron route and the manual `/api/strategy/run` endpoint behind the Strategy tab's button), rate-limited to Kite's 3 req/sec historical-data cap in batches of 3, now scanning every F&O stock rather than just the Liquid bucket. It checkpoint-saves after the stocks phase so an indices-phase timeout doesn't lose the run. `maxDuration` is set to 300s, but Vercel's Hobby plan hard-caps actual function duration at 60s regardless — if runs are timing out before finishing the full stock list, that's the plan's limit, not a code bug; upgrading to Pro removes it.
- `package.json` doesn't pin `package-lock.json` — it's regenerated deterministically by `npm install`.
- `app/strategy/page.tsx` reads whatever the daily job last stored; it doesn't compute anything itself.
