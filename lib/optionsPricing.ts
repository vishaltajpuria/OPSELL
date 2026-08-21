// Black-Scholes European option pricing, used to MODEL option premiums from
// the underlying's own price history. Kite doesn't reliably retain years of
// historical daily data for expired monthly option contracts at arbitrary
// strikes, so a real historical-premium backtest isn't available the way the
// underlying-stock one is — this estimates what a premium plausibly would
// have been instead. See lib/optionsBacktest.ts for how it's used, and treat
// the results as estimates, not exact historical fills.

// Abramowitz & Stegun 7.1.26 approximation of the error function, accurate
// to ~1.5e-7 — good enough for pricing, no external stats library needed.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-ax * ax);
  return sign * y;
}

function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Black-Scholes price for a European put or call. spot/strike in rupees,
 * yearsToExpiry as a fraction of a year, riskFreeRate/volatility as decimals
 * (0.065 = 6.5%). At yearsToExpiry <= 0, returns intrinsic value only (no
 * time value left, matching real expiry settlement).
 */
export function blackScholes(
  type: "call" | "put",
  spot: number,
  strike: number,
  yearsToExpiry: number,
  riskFreeRate: number,
  volatility: number
): number {
  if (yearsToExpiry <= 0) {
    return type === "call" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  }
  const sigma = Math.max(volatility, 0.0001);
  const sqrtT = Math.sqrt(yearsToExpiry);
  const d1 = (Math.log(spot / strike) + (riskFreeRate + (sigma * sigma) / 2) * yearsToExpiry) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  if (type === "call") {
    return spot * normCdf(d1) - strike * Math.exp(-riskFreeRate * yearsToExpiry) * normCdf(d2);
  }
  return strike * Math.exp(-riskFreeRate * yearsToExpiry) * normCdf(-d2) - spot * normCdf(-d1);
}

/**
 * Annualized realized volatility of the trailing `window` bars of closes
 * ending at `endIndex`, used as an implied-volatility proxy since real
 * historical IV data isn't available. Falls back to a flat 30% when there
 * isn't enough trailing history yet.
 *
 * periodsPerYear must match what one bar-to-bar step actually represents:
 * 252 for daily bars (the default), ~504 for 4H bars (~2/trading day), ~1008
 * for 2H bars (~4/trading day). Getting this wrong doesn't just skew the
 * number — annualizing intraday bar-to-bar returns with the daily 252 factor
 * would understate volatility by roughly sqrt(bars-per-day), since each
 * return only reflects a fraction of a day's actual movement.
 */
export function realizedVolatility(
  closes: number[],
  endIndex: number,
  window: number,
  periodsPerYear = 252
): number {
  const start = Math.max(1, endIndex - window + 1);
  const returns: number[] = [];
  for (let i = start; i <= endIndex; i++) {
    if (i < 1 || i >= closes.length) continue;
    const r = Math.log(closes[i] / closes[i - 1]);
    if (Number.isFinite(r)) returns.push(r);
  }
  if (returns.length < 5) return 0.3;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear);
}

/**
 * Last Thursday of the given month (NSE's standard monthly F&O expiry day —
 * this doesn't account for expiry-day shifts around exchange holidays).
 */
export function lastThursdayOfMonth(year: number, monthIndex0: number): Date {
  const d = new Date(Date.UTC(year, monthIndex0 + 1, 0)); // last calendar day of the month
  const dow = d.getUTCDay(); // 0=Sun..6=Sat, Thursday=4
  const diff = (dow - 4 + 7) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}
