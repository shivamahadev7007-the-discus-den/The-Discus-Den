/**
 * Live catalogue reader for the Chat Assistant.
 *
 * Prices are NEVER hard-coded: they are parsed from the server-rendered HTML
 * of thediscusden.com/available (strains) and /frozen + /pellets (food).
 * Results are cached in the runtime for CHAT_PRICE_CACHE_SECONDS (default
 * 60 s; 0 = always fetch live). On any fetch or parse
 * failure the loader returns null and the router replies with the pack's
 * fallback pointing to /available. It never guesses.
 *
 * Only name, size, one-line description and price are read. Nothing else on
 * the page (cart quantity controls etc.) is used.
 */

import { AVAILABLE_URL, FROZEN_URL, PELLETS_URL } from "./answers.ts";

export type StrainCard = {
  name: string;
  size: string;
  description: string;
  /** Rupees per piece. */
  price: number;
  /** Exactly as shown on the card, e.g. "₹3,250". */
  priceText: string;
  available: boolean;
};

export type FoodPack = { size: string; price: number; priceText: string };
export type FoodItem = { name: string; description: string; packs: FoodPack[] };

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** Default price cache TTL (Shiva, 2 Oct: ~1 min; 0 means always live). */
export const DEFAULT_PRICE_CACHE_SECONDS = 60;

/** Parse CHAT_PRICE_CACHE_SECONDS: unset/invalid -> 60, "0" -> 0 (no cache). */
export function priceCacheMsFromEnv(env: Record<string, string | undefined> = {}): number {
  const raw = env.CHAT_PRICE_CACHE_SECONDS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PRICE_CACHE_SECONDS * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PRICE_CACHE_SECONDS * 1000;
  return Math.floor(n * 1000);
}
const FETCH_TIMEOUT_MS = 4000;

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function cleanText(s: string): string {
  return decodeEntities(s.replace(/<!--.*?-->/gs, "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Split an article's HTML into visible text segments, in order. */
function segments(html: string): string[] {
  const stripped = html
    .replace(/<!--.*?-->/gs, "")
    .replace(/<(script|style|svg|button)\b[\s\S]*?<\/\1>/gi, " ");
  return stripped
    .split(/<[^>]+>/)
    .map((s) => decodeEntities(s).replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function articles(html: string): string[] {
  return html.match(/<article\b[\s\S]*?<\/article>/gi) ?? [];
}

const PRICE_RE = /^₹\s?(\d{1,3}(?:,\d{2,3})*|\d+)$/;

function parsePrice(seg: string): number | null {
  const m = PRICE_RE.exec(seg.trim());
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 && n < 1_000_000 ? n : null;
}

function heading(html: string): string | null {
  const m = /<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i.exec(html);
  return m ? cleanText(m[1]!) || null : null;
}

function overlayLabel(html: string): string | null {
  // The size / pack label printed over the card image.
  const m = /<p\b[^>]*class="[^"]*\babsolute\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  return m ? cleanText(m[1]!) || null : null;
}

// ---------------------------------------------------------------------------
// Parsers (pure, exported for tests)
// ---------------------------------------------------------------------------

export function parseAvailableHtml(html: string): StrainCard[] {
  const out: StrainCard[] = [];
  for (const art of articles(html)) {
    const name = heading(art);
    if (!name) continue;
    const segs = segments(art);
    const nameIdx = segs.indexOf(name);
    const priceIdx = segs.findIndex((s) => parsePrice(s) !== null);
    const outOfStock = /\b(out of stock|sold out)\b/i.test(segs.join(" "));
    if (priceIdx < 0 && !outOfStock) continue;
    const size = overlayLabel(art) ?? (nameIdx > 0 ? segs[nameIdx - 1]! : "");
    const descCandidate = nameIdx >= 0 ? segs[nameIdx + 1] : undefined;
    const description =
      descCandidate && parsePrice(descCandidate) === null && !/^qty$/i.test(descCandidate)
        ? descCandidate
        : "";
    const price = priceIdx >= 0 ? parsePrice(segs[priceIdx]!)! : 0;
    out.push({
      name,
      size,
      description,
      price,
      priceText: priceIdx >= 0 ? segs[priceIdx]!.replace(/\s+/g, "") : "",
      available: !outOfStock && price > 0,
    });
  }
  return out;
}

const PACK_RE = /^\d+(?:\.\d+)?\s?(?:g|kg|gm|gms|ml|l)$/i;

export function parseFoodHtml(html: string): FoodItem[] {
  const out: FoodItem[] = [];
  for (const art of articles(html)) {
    const name = heading(art);
    if (!name) continue;
    const segs = segments(art);
    const nameIdx = segs.indexOf(name);
    const desc = nameIdx >= 0 ? segs[nameIdx + 1] ?? "" : "";
    const packs: FoodPack[] = [];
    for (let i = 0; i < segs.length - 1; i += 1) {
      if (PACK_RE.test(segs[i]!) && parsePrice(segs[i + 1]!) !== null) {
        packs.push({ size: segs[i]!, price: parsePrice(segs[i + 1]!)!, priceText: segs[i + 1]!.replace(/\s+/g, "") });
      }
    }
    if (!packs.length) {
      // Single-price card (e.g. pellets): pack size is the image label.
      const priceSeg = segs.find((s) => parsePrice(s) !== null);
      const label = overlayLabel(art);
      if (priceSeg) {
        packs.push({ size: label && PACK_RE.test(label) ? label : "", price: parsePrice(priceSeg)!, priceText: priceSeg.replace(/\s+/g, "") });
      }
    }
    out.push({ name, description: parsePrice(desc) === null ? desc : "", packs });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Live loader with a ~10 min runtime cache
// ---------------------------------------------------------------------------

type CacheSlot<T> = { at: number; data: T };
type Cache = Map<string, CacheSlot<unknown>>;

async function fetchHtml(url: string, fetchImpl: FetchLike): Promise<string | null> {
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "TheDiscusDen-ChatAssistant/1.0", accept: "text/html" },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function cached<T>(
  cache: Cache,
  ttlMs: number,
  key: string,
  load: () => Promise<T | null>,
  now: () => number,
): Promise<T | null> {
  if (ttlMs <= 0) return load(); // always live
  const slot = cache.get(key) as CacheSlot<T> | undefined;
  if (slot && now() - slot.at < ttlMs) return slot.data;
  const data = await load();
  // Failures are never cached, so the next message retries the live page.
  if (data !== null) cache.set(key, { at: now(), data });
  return data;
}

export type CatalogLoader = {
  strains(): Promise<StrainCard[] | null>;
  foods(): Promise<{ frozen: FoodItem[] | null; pellets: FoodItem[] | null }>;
};

export function createCatalogLoader(opts?: { fetch?: FetchLike; now?: () => number; cacheMs?: number }): CatalogLoader {
  const ttlMs = opts?.cacheMs ?? DEFAULT_PRICE_CACHE_SECONDS * 1000;
  const fetchImpl: FetchLike = opts?.fetch ?? ((url, init) => fetch(url, init));
  const now = opts?.now ?? Date.now;
  // One cache per loader; the API route creates a single loader per warm
  // serverless instance, so the cache lives as long as the instance.
  const store: Cache = new Map();
  return {
    strains: () =>
      cached(
        store,
        ttlMs,
        "available",
        async () => {
          const html = await fetchHtml(AVAILABLE_URL, fetchImpl);
          if (!html) return null;
          const cards = parseAvailableHtml(html).filter((c) => c.name);
          // A page we can't read must never be mistaken for "nothing available".
          return cards.length ? cards : null;
        },
        now,
      ),
    foods: async () => {
      const load = (key: string, url: string) =>
        cached(
          store,
          ttlMs,
          key,
          async () => {
            const html = await fetchHtml(url, fetchImpl);
            if (!html) return null;
            const items = parseFoodHtml(html);
            return items.length ? items : null;
          },
          now,
        );
      const [frozen, pellets] = await Promise.all([load("frozen", FROZEN_URL), load("pellets", PELLETS_URL)]);
      return { frozen, pellets };
    },
  };
}
