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
 * Read from the page: name, size, one-line description and price per card,
 * plus the owner name printed in the site footer. Stock counts (3 Oct rule:
 * the bot may share what the public site shows) come from the same strain
 * list the /available page renders: the site's own client bundle, where each
 * card's quantity stepper is capped at its `stock`. A count is attached only
 * when the bundle lists that exact card name; otherwise it stays undefined
 * and the bot points to /available instead of guessing.
 */

import { AVAILABLE_URL, FROZEN_URL, PELLETS_URL, SITE_URL } from "./answers.ts";

export type StrainCard = {
  name: string;
  size: string;
  description: string;
  /** Rupees per piece. */
  price: number;
  /** Exactly as shown on the card, e.g. "₹3,250". */
  priceText: string;
  available: boolean;
  /** Pieces the site lists for this card (its qty cap). Undefined = not listed / couldn't read. */
  stock?: number;
};

export type SiteInfo = { owner: string | null };

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

/** URL path of the site's main client bundle, referenced from every page. */
export function findSiteBundlePath(html: string): string | null {
  const m = /\/assets\/index-[A-Za-z0-9_-]+\.js/.exec(html);
  return m ? m[0] : null;
}

/**
 * Stock per card name, from the site bundle's strain list: objects like
 * {id:`blue-diamond`,name:`Blue Diamonds (Big)`,...,price:3750,stock:25}.
 * Only objects that carry both a name and an integer stock are read.
 */
export function parseSiteStock(js: string): Map<string, number> {
  const out = new Map<string, number>();
  const re = /\bname:\s*(?:`([^`]{1,80})`|"([^"]{1,80})"|'([^']{1,80})')[^{}]*?\bstock:\s*(\d{1,4})\b/g;
  for (const m of js.matchAll(re)) {
    const name = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    const n = Number(m[4]);
    if (name && Number.isInteger(n) && !out.has(normName(name))) out.set(normName(name), n);
  }
  return out;
}

export function normName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Attach site-listed stock to cards by exact (normalised) card name. */
export function attachStock(cards: StrainCard[], stock: Map<string, number> | null): StrainCard[] {
  if (!stock || stock.size === 0) return cards;
  return cards.map((c) => {
    const n = stock.get(normName(c.name));
    return n === undefined ? c : { ...c, stock: n };
  });
}

/**
 * Owner name as printed in the site footer:
 * "The Discus Den | <Owner> | Chennai | GSTIN : ...". Returns null when the
 * footer doesn't have that shape (the bot then uses its standing name).
 */
export function parseOwnerName(html: string): string | null {
  const segs = segments(html.replace(/<article\b[\s\S]*?<\/article>/gi, " "));
  const g = segs.findIndex((s) => /^GSTIN\b/i.test(s));
  if (g < 2) return null;
  const cand = segs[g - 2]!;
  if (!/^\p{Lu}[\p{L}.']{1,30}(?: \p{Lu}[\p{L}.']{0,30}){0,2}$/u.test(cand)) return null;
  if (/discus|den|chennai|gstin/i.test(cand)) return null;
  return cand;
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
      headers: { "user-agent": "TheDiscusDen-ChatAssistant/1.0", accept: "text/html, */*;q=0.8" },
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
  /** Owner name etc. read from the site; optional so simple test loaders can omit it. */
  site?(): Promise<SiteInfo | null>;
  foods(): Promise<{ frozen: FoodItem[] | null; pellets: FoodItem[] | null }>;
};

export function createCatalogLoader(opts?: { fetch?: FetchLike; now?: () => number; cacheMs?: number }): CatalogLoader {
  const ttlMs = opts?.cacheMs ?? DEFAULT_PRICE_CACHE_SECONDS * 1000;
  const fetchImpl: FetchLike = opts?.fetch ?? ((url, init) => fetch(url, init));
  const now = opts?.now ?? Date.now;
  // One cache per loader; the API route creates a single loader per warm
  // serverless instance, so the cache lives as long as the instance.
  const store: Cache = new Map();
  // The bundle URL is content-hashed (a stock change on the site ships a new
  // file name), so a parsed bundle is kept per path. Failed reads aren't kept.
  const bundles = new Map<string, Map<string, number>>();
  const bundleStock = async (path: string | null): Promise<Map<string, number> | null> => {
    if (!path) return null;
    const hit = bundles.get(path);
    if (hit) return hit;
    const js = await fetchHtml(`${SITE_URL}${path}`, fetchImpl);
    if (!js) return null;
    const stock = parseSiteStock(js);
    if (bundles.size >= 4) bundles.clear();
    bundles.set(path, stock);
    return stock;
  };
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
          if (!cards.length) return null;
          const owner = parseOwnerName(html);
          if (owner) store.set("site", { at: now(), data: { owner } satisfies SiteInfo });
          // Counts are best effort: if the bundle can't be read, cards simply
          // carry no stock and the bot points to /available for counts.
          return attachStock(cards, await bundleStock(findSiteBundlePath(html)));
        },
        now,
      ),
    site: () =>
      cached(
        store,
        ttlMs,
        "site",
        async () => {
          const html = await fetchHtml(AVAILABLE_URL, fetchImpl);
          const owner = html ? parseOwnerName(html) : null;
          return owner ? { owner } : null;
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
