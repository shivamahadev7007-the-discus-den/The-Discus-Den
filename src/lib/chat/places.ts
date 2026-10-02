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
  [["dubai", "uae", "abu dhabi", "sharjah", "qatar", "doha", "saudi", "oman", "muscat", "kuwait", "bahrain", "usa", "america", "uk", "london", "canada", "australia", "singapore", "malaysia", "sri lanka", "colombo", "nepal", "bangladesh", "abroad", "overseas", "outside india", "out of india", "united states", "united kingdom", "international", "internationally", "germany", "europe", "japan", "hong kong", "maldives", "thailand"], "Outside India", "abroad"],
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
