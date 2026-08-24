# OPSELL

A mobile web app for an AI-assisted option-selling strategy on NSE F&O (futures & options) stocks, using your Zerodha account as the data source. It's built to be added to your iPhone home screen so it behaves like a regular app, no App Store needed.

**Where things stand right now:** you can log in with Zerodha and land on the **Strategy** tab, which shows Short/Super Short/Long/Super Long signals from a Supertrend + SMA crossover strategy, in two side-by-side Daily and 4H columns, computed automatically every trading day after market close. The **Positions** tab shows your currently open positions straight from Zerodha (symbol, product, quantity, average price, LTP, live P&L) — this is a read-only mirror of your actual account, not something the app tracks itself. There's also a live option-chain view per stock (strikes, LTP, open interest, any expiry) at `/stocks/[symbol]` — not linked from the bottom nav, since the F&O scanner list that used to link to it was removed, but the route and page still work if you type/bookmark the URL directly.

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

## Backtesting the strategy

There's a `/backtest` page (not in the bottom nav — open it directly by URL) for checking how the strategy would have performed historically on any list of stocks *or indices* you choose, on **Daily, 4H, and/or 2H — pick any combination, not just one at a time.** Paste in symbols (e.g. today's top stocks by market cap — Kite's Watchlist can sort by market cap — or index keys: NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX), tap however many timeframe buttons you want selected, and it fetches candles per (symbol, timeframe) pair and walk-forward simulates every signal the strategy would have fired, not just the latest one. Results are grouped into a separate labeled section per selected timeframe, each with its own summary/per-stock/trade-list, so you can directly compare the same symbols across timeframes in one run. The CSV export includes every selected timeframe's data in one file (a `Timeframe` column, plus a labeled summary block per timeframe up top). Index symbols are resolved via `getIndexToken()` (same one the Strategy tab's index runs use) instead of `getEquityToken()` — the route (`app/api/strategy/backtest/route.ts`) checks each pasted symbol against `INDEX_DEFS` from `lib/indices.ts` first and falls back to the equity lookup.

**Timeframe** matters for how much history is available, not just candle size: Daily fetches ~5.4 years of calendar days (Kite's cap on a single "day"-interval request is ~2000 days), giving roughly **4.6 years** the strategy can actually fire signals on, after the ~210-bar SMA200/Supertrend warm-up eats into the front of the range. Going further would need chunking multiple requests per symbol, which isn't done. 4H and 2H are resampled from 60-minute candles (`resampleTo4H`/`resampleTo2H` in `lib/indicators.ts`, session-anchored — the last bar of each day is short rather than calendar-aligned), and Kite's historical endpoint caps 60-minute-interval requests to ~400 days regardless of what's requested, so intraday backtests only cover roughly the last 13 months — that ceiling doesn't move with the daily lookback.

Each selected timeframe needs its own historical request per symbol, so the request count is `symbols × timeframes selected` — not a flat per-symbol count anymore. The UI's soft cap is 150 total requests (e.g. up to 150 symbols on one timeframe, or up to 50 symbols with all three selected), enforced client-side with a message telling you the max symbol count for your current timeframe selection; the route (`MAX_WORK_ITEMS`, currently 300) hard-caps the same thing server-side as a safety net.

Two things scale with the chosen timeframe rather than staying fixed, since a "bar" means a different amount of real time on each one:
- The unresolved-trade cutoff (~90 bars, previously always ~90 calendar days) scales up on intraday timeframes so it still covers roughly the same real-world window — ~180 bars on 4H, ~360 on 2H — instead of quietly becoming "~45 days" or "~22 days" just because a bar is smaller.
- In option-selling mode, the realized-volatility estimate's window and annualization factor scale the same way (`volWindowBars`/`periodsPerYear` in `lib/optionsBacktest.ts`) — annualizing intraday bar-to-bar returns with the daily 252-per-year factor would understate volatility by roughly √(bars-per-day), since each bar only reflects a fraction of a day's actual movement.

Fetches run batched at Kite's 3 requests/second historical-data limit (`lib/rateLimit.ts`, shared with the daily/4H strategy run) rather than one at a time, so e.g. 100 symbols takes roughly 35 seconds, not 100+. The 150-symbol soft cap in `components/BacktestRunner.tsx` exists because Vercel Hobby hard-caps a function at 60 seconds — past ~150-170 symbols in one run, that budget gets tight; split a bigger list into two runs instead.

Since the target is a moving SMA line, not a fixed price, the simulation has to make a few calls about how a trade actually plays out — worth knowing before trusting the numbers:
- Entry is the next day's open after a signal (the signal itself is only known once that day's candle closes — entering at that same day's close would be lookahead bias).
- A trade exits the first day price actually touches the target SMA's *current* value (checked against that day's low for a short, high for a long) — the target moves with the SMA each day, exactly as you described.
- The optional "Stop loss %" field adds a fixed price stop (checked against that day's high for a short, low for a long), checked first each day, ahead of the target — a day where both would technically trigger is conservatively treated as a stop-out. Leave it blank to skip this and rely only on the next rule.
- If neither the stop loss nor the target is hit, the trade exits the first day Supertrend flips against the position, at that day's close — the strategy's own signal that the setup broke, used here as a second, unbounded stop-loss rule since the strategy itself is signal-only and doesn't define one.
- Only one trade per stock at a time — a new signal while a trade is already open is ignored until that trade exits.
- A trade neither hit nor invalidated within ~90 trading days (or still running when the data runs out) is marked "open", excluded from the win/loss rate rather than forced into either bucket.
- The **Direction** selector (All / Short only / Long only) restricts which signals get taken at all — the excluded direction isn't just filtered from the results, it's skipped during detection, so an excluded long signal doesn't block a later short one from firing on the same stock. Useful since large-cap NSE stocks tend to drift upward over multi-year windows, which structurally favors longs in an unfiltered backtest — Short only isolates whether the short side holds up on its own.

See the doc comment on `backtestSymbol()` in `lib/backtest.ts` for the full reasoning — these are reasonable defaults, not something the strategy itself specifies, so it's easy to point back to this if a number looks off and you want a rule changed.

### Modeling it as option-selling instead

The **"Model as option-selling"** checkbox turns each stock- or index-level trade into what selling an option against that same signal would have looked like: a long signal sells a ~3% out-of-the-money put, a short signal sells a ~3% OTM call, both expiring on the near-month NSE **monthly** expiry (rolls to next month if the signal fires after that month's expiry already passed) — `nearMonthExpiry()` always computes the last Thursday of the month and never touches a weekly expiry date, so this holds for indices too even though NIFTY/BANKNIFTY etc. also have weekly contracts in real life. The option is priced with the Black-Scholes formula (`lib/optionsPricing.ts`) using volatility estimated from the underlying's own trailing 20-day realized volatility as a stand-in for implied volatility, since Kite doesn't reliably retain historical data for expired option contracts the way it does for the underlying — **these are modeled estimates, not real historical option prices.** If the underlying trade's own exit (target/stop/Supertrend-flip) would land after that month's expiry, the option is instead settled at expiry using intrinsic value only, matching real expiry mechanics (`lib/optionsBacktest.ts`'s `toOptionTrade()`).

Results are reported in **₹ per share, not %** — % of a small, far-OTM premium can swing to numbers like -20,000% on a single bad trade (mathematically correct — a naked option seller genuinely can lose many multiples of the tiny premium collected — but useless for averaging across trades), so ₹ terms are what's aggregated and compared. Sanity-tested against synthetic price paths before shipping: selling into a rally decays a put toward worthless (positive ₹ P&L), selling into a crash blows the same put's value up far past what was collected (a large negative ₹ P&L, correctly uncapped), and an unresolved trade correctly settles at expiry using intrinsic value.

An optional **"Spread width %"** field (shown once option-selling mode is on, defaults to 4) turns the naked short into a credit spread: a second, protective leg is bought further OTM — short leg stays ~3% OTM, long leg sits at ~3%+width% OTM, both same expiry. The max loss per trade becomes capped at (strike width − net credit collected), shown per-trade and as an "Avg capped max loss" summary line, instead of the naked short's unbounded downside. Leave the field blank to go back to naked. Verified against the earlier naked-crash sanity case: the same crash that cost the naked put ₹127.89/share cost the 4%-wide spread only ₹37.81/share — exactly matching its own computed max loss, confirming the cap holds even when the underlying blows straight through both strikes.

## Notes for whoever maintains this later

- Built with Next.js 14 (App Router) + TypeScript + Tailwind CSS.
- Talks to Kite Connect directly over `fetch` (no third-party Kite SDK), to avoid pulling in that SDK's outdated, vulnerable transitive dependencies.
- The instrument dump is cached in memory per server process for 6 hours; on serverless hosts each cold start refetches it once.
- `lib/indicators.ts` / `lib/strategy.ts` hold the Supertrend + SMA math and crossover detection, kept as pure functions over candle arrays — no I/O, easy to unit test in isolation.
- `lib/runDailyStrategy.ts` exports two independent functions, `runDailyTimeframeStrategy(accessToken, batchId)` and `run4HTimeframeStrategy(accessToken, batchId)`, each taking a `batchId` ("A" or "B" — see `BATCH_IDS` in `lib/kv.ts`) that selects which alphabetical slice of the full F&O stock list to process (`partitionForBatch`). Each is shared between its own cron route (`app/api/cron/daily-strategy` / `-4h`, both reading `?batch=` from the query string) and its own manual endpoint (`app/api/strategy/run` / `run-4h`, same query param) behind the Strategy tab's button. All four (batch × timeframe) combinations are rate-limited to Kite's 3 req/sec historical-data cap in batches of 3 and checkpoint-save after their stocks phase so an indices-phase timeout doesn't lose that invocation's run; indices only run alongside batch "A". `maxDuration` is set to 300s on each route, but Vercel's Hobby plan hard-caps actual function duration at 60s regardless — which is exactly why the work is split into 4 invocations instead of 1 or 2; upgrading to Pro removes that cap (at which point `BATCH_IDS` could shrink back to a single batch). `lib/kv.ts`'s `saveSignalBatch()` writes each (date, timeframe, batchId) combination to its own Redis key and republishes a merged view across all of them, so batches that run minutes apart in separate function invocations with no shared memory can't clobber each other.
- `package.json` doesn't pin `package-lock.json` — it's regenerated deterministically by `npm install`.
- `app/strategy/page.tsx` reads whatever the daily job last stored; it doesn't compute anything itself.
