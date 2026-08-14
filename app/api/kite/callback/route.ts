import { NextRequest, NextResponse } from "next/server";
import { generateSession } from "@/lib/kite";
import { KITE_TOKEN_COOKIE, TOKEN_MAX_AGE_SECONDS } from "@/lib/session";
import { setStoredAccessToken } from "@/lib/kv";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const requestToken = searchParams.get("request_token");
  const status = searchParams.get("status");

  if (status !== "success" || !requestToken) {
    const reason = searchParams.get("error") ?? "Zerodha login was cancelled or failed.";
    return NextResponse.redirect(new URL(`/settings?error=${encodeURIComponent(reason)}`, request.url));
  }

  try {
    const session = await generateSession(requestToken);
    // The daily cron job has no browser cookie to authenticate with, so mirror
    // the token to KV for it — but don't let a missing/misconfigured KV store
    // (e.g. not provisioned yet) block the browser login flow itself.
    try {
      await setStoredAccessToken(session.access_token);
    } catch {
      // ignored — the daily routine just won't have a token to work with yet
    }
    const response = NextResponse.redirect(new URL("/stocks", request.url));
    response.cookies.set(KITE_TOKEN_COOKIE, session.access_token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: TOKEN_MAX_AGE_SECONDS,
    });
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not complete Zerodha login.";
    return NextResponse.redirect(new URL(`/settings?error=${encodeURIComponent(message)}`, request.url));
  }
}
