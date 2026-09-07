// NSE's regular equity/F&O session is 9:15 AM to 3:30 PM IST. Using 3:40
// here per an explicit request to allow a few extra minutes past the real
// close (e.g. for closing out a position against the closing auction) —
// worth knowing this doesn't match NSE's own posted hours if that ever
// matters elsewhere.
const MARKET_OPEN_MINUTES = 9 * 60 + 15; // 9:15
const MARKET_CLOSE_MINUTES = 15 * 60 + 40; // 15:40

/**
 * NSE-observed trading holidays, IST calendar dates (YYYY-MM-DD). Only the
 * THREE fixed national holidays are filled in below — Republic Day,
 * Independence Day, and Gandhi Jayanti never move, so they're safe to
 * hardcode. Every other NSE holiday (Holi, Good Friday, Ram Navami, Eid,
 * Buddha Purnima, Muharram, Ganesh Chaturthi, Dussehra, Diwali/Balipratipada,
 * Guru Nanak Jayanti, Christmas, and any one-off closure) is a movable date
 * set by NSE's own annual circular (published every December for the
 * following year) — deliberately left OUT rather than guessed, since a
 * wrong hardcoded date is worse than a missing one. Update this list from
 * NSE's official holiday calendar (nseindia.com, or the list inside the
 * Kite/Console app) at the start of each year.
 */
export const NSE_HOLIDAYS: Record<string, string[]> = {
  "2026": [
    "2026-01-26", // Republic Day
    "2026-08-15", // Independence Day
    "2026-10-02", // Gandhi Jayanti
  ],
};

function getIstParts(date: Date): { isoDate: string; weekday: number; minutesSinceMidnight: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  const isoDate = `${parts.year}-${parts.month}-${parts.day}`;
  const weekdayIndex: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayIndex[parts.weekday] ?? -1;
  // Intl can render midnight as "24" with hour12:false in some runtimes.
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  const minutesSinceMidnight = hour * 60 + Number(parts.minute);
  return { isoDate, weekday, minutesSinceMidnight };
}

export type MarketStatus = { open: true } | { open: false; reason: "weekend" | "holiday" | "outside_hours" };

export function getMarketStatus(date: Date = new Date()): MarketStatus {
  const { isoDate, weekday, minutesSinceMidnight } = getIstParts(date);
  if (weekday === 0 || weekday === 6) return { open: false, reason: "weekend" };
  const year = isoDate.slice(0, 4);
  if ((NSE_HOLIDAYS[year] ?? []).includes(isoDate)) return { open: false, reason: "holiday" };
  if (minutesSinceMidnight < MARKET_OPEN_MINUTES || minutesSinceMidnight >= MARKET_CLOSE_MINUTES) {
    return { open: false, reason: "outside_hours" };
  }
  return { open: true };
}

export function isMarketOpen(date: Date = new Date()): boolean {
  return getMarketStatus(date).open;
}

export function marketClosedMessage(status: Extract<MarketStatus, { open: false }>): string {
  switch (status.reason) {
    case "weekend":
      return "Markets are closed on weekends.";
    case "holiday":
      return "Markets are closed today for an NSE trading holiday.";
    case "outside_hours":
      return "Markets are only open 9:15 AM – 3:40 PM IST.";
  }
}
