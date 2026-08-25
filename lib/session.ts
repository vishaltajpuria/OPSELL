import { cookies } from "next/headers";

export const KITE_TOKEN_COOKIE = "opsell_kite_token";

// Zerodha access tokens are valid until the platform-wide daily reset
// (early morning IST), so a 20-hour cookie roughly matches that lifetime
// without outliving a stale token.
export const TOKEN_MAX_AGE_SECONDS = 20 * 60 * 60;

export function getAccessToken(): string | null {
  return cookies().get(KITE_TOKEN_COOKIE)?.value ?? null;
}

export function isConnected(): boolean {
  return getAccessToken() !== null;
}

/**
 * Drops the stored access token cookie. Zerodha invalidates every access
 * token platform-wide once a day (early morning IST) regardless of when it
 * was issued, so a cookie that hasn't hit its own 20-hour max-age can still
 * point at a token Zerodha has already killed — the first Kite call to
 * discover that (see the TokenException handling in lib/kite.ts) clears it
 * here so the app stops claiming to be "connected" and the next page load
 * correctly redirects to Settings to reconnect.
 */
export function clearAccessToken(): void {
  try {
    cookies().delete(KITE_TOKEN_COOKIE);
  } catch {
    // Next.js only allows mutating cookies from a Server Action or Route
    // Handler — this can also be reached from a Server Component's render
    // (e.g. app/stocks/[symbol]/page.tsx calling getOptionChain directly),
    // where it throws. Harmless to skip there: the caller's own error still
    // propagates, and the cookie's own 20-hour max-age or the next Route
    // Handler call that hits this same dead token will clear it instead.
  }
}
