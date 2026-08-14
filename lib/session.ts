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
