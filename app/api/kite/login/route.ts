import { NextRequest, NextResponse } from "next/server";
import { getLoginUrl } from "@/lib/kite";

export async function GET(request: NextRequest) {
  try {
    return NextResponse.redirect(getLoginUrl());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start Zerodha login.";
    return NextResponse.redirect(new URL(`/settings?error=${encodeURIComponent(message)}`, request.url));
  }
}
