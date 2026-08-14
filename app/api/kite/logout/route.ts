import { NextRequest, NextResponse } from "next/server";
import { KITE_TOKEN_COOKIE } from "@/lib/session";

export async function GET(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/settings", request.url));
  response.cookies.delete(KITE_TOKEN_COOKIE);
  return response;
}
