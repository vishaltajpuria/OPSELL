// Kite's historical-data endpoint is limited to 3 requests/second; this runs
// work in small concurrent batches rather than either serial (slow — wastes
// time waiting even after a batch finishes early) or unbounded parallel
// (hits the rate limit). Shared by the daily/4H strategy run and the
// backtest, both of which fetch one historical-candle series per symbol.
const BATCH_SIZE = 3;
const BATCH_WINDOW_MS = 1000;

export async function runRateLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const started = Date.now();
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    const elapsed = Date.now() - started;
    if (i + BATCH_SIZE < items.length && elapsed < BATCH_WINDOW_MS) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_WINDOW_MS - elapsed));
    }
  }
  return results;
}
