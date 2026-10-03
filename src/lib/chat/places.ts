/**
 * Place lookup for shipping answers and the lead alert.
 * "in"     = one of the 8 train-delivery states
 * "other"  = another Indian state/UT (deliver on request -> handoff)
 * "remote" = very remote (best effort, no guarantee -> handoff)
 * "abroad" = outside India (not covered by the pack -> handoff)
 */

export type PlaceZone = "in" | "other" | "remote" | "abroad";
export type Place = { name: string; state: string; zone: PlaceZone };

type Entry = [aliases: string[], state: string, zone: PlaceZone];

const ENTRIES: Entry[] = [
  // 8 states (names + main cities)
  [["tamil nadu", "tamilnadu", "chennai", "madras", "madurai", "coimbatore", "kovai", "trichy", "tiruchirappalli", "salem", "tirunelveli", "erode", "vellore", "thanjavur", "tiruppur", "hosur", "pondicherry", "puducherry", "pondy", "kanchipuram", "nagercoil", "thoothukudi", "tuticorin", "karur", "dindigul"], "Tamil Nadu", "in"],
  [["kerala", "kochi", "cochin", "ernakulam", "trivandrum", "thiruvananthapuram", "kozhikode", "calicut", "thrissur", "kollam", "kannur", "palakkad", "alappuzha", "kottayam", "malappuram"], "Kerala", "in"],
  [["karnataka", "bangalore", "bengaluru", "mysore", "mysuru", "mangalore", "mangaluru", "hubli", "dharwad", "belgaum", "belagavi", "udupi", "shimoga", "davangere", "tumkur"], "Karnataka", "in"],
  [["andhra pradesh", "andhra", "vizag", "visakhapatnam", "vijayawada", "guntur", "tirupati", "nellore", "kurnool", "kakinada", "rajahmundry", "anantapur"], "Andhra Pradesh", "in"],
  [["telangana", "hyderabad", "secunderabad", "warangal", "karimnagar", "nizamabad", "khammam"], "Telangana", "in"],
  [["maharashtra", "mumbai", "bombay", "pune", "nagpur", "nashik", "thane", "navi mumbai", "aurangabad", "kolhapur", "solapur", "amravati"], "Maharashtra", "in"],
  [["madhya pradesh", "indore", "bhopal", "jabalpur", "gwalior", "ujjain"], "Madhya Pradesh", "in"],
  [["odisha", "orissa", "bhubaneswar", "cuttack", "rourkela", "puri", "sambalpur", "berhampur"], "Odisha", "in"],
  // Other states / UTs
  [["delhi", "new delhi", "noida", "gurgaon", "gurugram", "faridabad", "ghaziabad"], "Delhi NCR", "other"],
  [["goa", "panaji", "margao"], "Goa", "other"],
  [["gujarat", "ahmedabad", "surat", "vadodara", "baroda", "rajkot"], "Gujarat", "other"],
  [["rajasthan", "jaipur", "jodhpur", "udaipur", "kota"], "Rajasthan", "other"],
  [["uttar pradesh", "lucknow", "kanpur", "varanasi", "agra", "prayagraj", "allahabad"], "Uttar Pradesh", "other"],
  [["west bengal", "kolkata", "calcutta", "siliguri", "durgapur"], "West Bengal", "other"],
  [["bihar", "patna", "gaya"], "Bihar", "other"],
  [["jharkhand", "ranchi", "jamshedpur", "dhanbad"], "Jharkhand", "other"],
  [["chhattisgarh", "raipur", "bilaspur"], "Chhattisgarh", "other"],
  [["punjab", "ludhiana", "amritsar", "jalandhar"], "Punjab", "other"],
  [["haryana", "chandigarh", "panipat", "ambala"], "Haryana", "other"],
  [["uttarakhand", "dehradun", "haridwar"], "Uttarakhand", "other"],
  [["himachal", "shimla", "manali"], "Himachal Pradesh", "other"],
  [["assam", "guwahati", "dibrugarh"], "Assam", "other"],
  // Very remote
  [["andaman", "nicobar", "port blair"], "Andaman and Nicobar", "remote"],
  [["lakshadweep", "kavaratti"], "Lakshadweep", "remote"],
  [["ladakh", "leh", "kargil"], "Ladakh", "remote"],
  [["kashmir", "srinagar", "jammu"], "Jammu and Kashmir", "remote"],
  [["arunachal", "itanagar"], "Arunachal Pradesh", "remote"],
  [["mizoram", "aizawl"], "Mizoram", "remote"],
  [["nagaland", "kohima", "dimapur"], "Nagaland", "remote"],
  [["manipur", "imphal"], "Manipur", "remote"],
  [["meghalaya", "shillong"], "Meghalaya", "remote"],
  [["tripura", "agartala"], "Tripura", "remote"],
  [["sikkim", "gangtok"], "Sikkim", "remote"],
  // Abroad
  [["dubai", "uae", "abu dhabi", "sharjah", "qatar", "doha", "saudi", "oman", "muscat", "kuwait", "bahrain", "usa", "america", "uk", "london", "canada", "australia", "singapore", "malaysia", "sri lanka", "colombo", "nepal", "bangladesh", "abroad", "overseas", "outside india", "out of india", "united states", "united kingdom", "international", "internationally", "germany", "europe", "japan", "hong kong", "maldives", "thailand", "kuala lumpur", "penang", "johor", "brunei", "indonesia", "jakarta", "bali", "philippines", "manila", "vietnam", "china", "beijing", "shanghai", "korea", "seoul", "tokyo", "taiwan", "bangkok", "myanmar", "bhutan", "kathmandu", "dhaka", "pakistan", "karachi", "lahore", "afghanistan", "riyadh", "jeddah", "dammam", "mauritius", "seychelles", "south africa", "kenya", "nigeria", "egypt", "france", "paris", "italy", "spain", "netherlands", "amsterdam", "ireland", "dublin", "berlin", "frankfurt", "munich", "switzerland", "sweden", "norway", "denmark", "scotland", "manchester", "new york", "new jersey", "california", "texas", "chicago", "toronto", "vancouver", "sydney", "melbourne", "perth", "brisbane", "new zealand", "auckland", "foreign", "outside the country", "other countries", "another country"], "Outside India", "abroad"],
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const COMPILED = ENTRIES.flatMap(([aliases, state, zone]) =>
  aliases.map((alias) => ({
    alias,
    state,
    zone,
    re: new RegExp(`(^|[^a-z])${escapeRe(alias)}([^a-z]|$)`, "i"),
  })),
  // Longer aliases first so "navi mumbai" beats "mumbai", "new delhi" beats "delhi".
).sort((a, b) => b.alias.length - a.alias.length);

/** Find the first known place mentioned in free text. */
export function findPlace(text: string): Place | null {
  const t = text.toLowerCase();
  for (const c of COMPILED) {
    if (c.re.test(t)) return { name: c.alias, state: c.state, zone: c.zone };
  }
  return null;
}

// ---------------------------------------------------------------------------
// LB-18 (Kiara 387ccb5): misspelt city names in timing asks ("banglore", "hydrabad",
// "chenai", "kochin", "mumbaai", "kolkatta"). Only words right after a place
// preposition (to / in / for / at / from / till / until / near) are tried, the
// first letter must match, and the word must be 1 letter off (2 for 7+ letters).
// ---------------------------------------------------------------------------
const FUZZY_STOP = new Set([
  "thank", "thanks", "there", "these", "those", "where", "which", "would", "could", "should", "about", "place", "small", "train",
  "order", "reach", "deliver", "delivery", "stock", "store", "station", "home", "house", "town", "village", "city", "state", "your", "their",
  "other", "another", "india", "anywhere", "somewhere", "buying", "orders", "parcel", "shipping", "receive", "collect", "pickup",
]);
function lev(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}
const SINGLE_WORD = COMPILED.filter((c) => !c.alias.includes(" ") && c.alias.length >= 5);

/** A known place behind a misspelt name ("how many days to banglore"); null if none or ambiguous. */
export function findPlaceFuzzy(text: string): Place | null {
  const t = text.toLowerCase();
  const words = [...t.matchAll(/\b(?:to|in|for|at|from|till|until|near|reach|reaches|arrive\s+(?:at|in))\s+([a-z]{5,})\b/g)].map((m) => m[1]!);
  for (const w of words) {
    if (FUZZY_STOP.has(w)) continue;
    let best: (typeof SINGLE_WORD)[number] | null = null;
    let bestD = 99;
    let tie = false;
    for (const c of SINGLE_WORD) {
      if (c.alias[0] !== w[0]) continue;
      const limit = c.alias.length >= 7 ? 2 : 1;
      const d = lev(w, c.alias);
      if (d === 0 || d > limit) continue;
      if (d < bestD) {
        best = c;
        bestD = d;
        tie = false;
      } else if (d === bestD && best && best.state !== c.state) tie = true;
    }
    if (best && !tie) return { name: best.alias, state: best.state, zone: best.zone };
  }
  return null;
}
