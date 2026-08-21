import { getQuote, type Quote } from "@/lib/kite";

// Kite's quote endpoint accepts many instruments per call, but we chunk
// defensively rather than assume an exact undocumented cap.
const QUOTE_CHUNK_SIZE = 400;

export async function batchQuote(keys: string[], accessToken: string): Promise<Record<string, Quote>> {
  if (keys.length === 0) return {};
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += QUOTE_CHUNK_SIZE) {
    chunks.push(keys.slice(i, i + QUOTE_CHUNK_SIZE));
  }
  const results = await Promise.all(chunks.map((chunk) => getQuote(chunk, accessToken)));
  return Object.assign({}, ...results);
}
