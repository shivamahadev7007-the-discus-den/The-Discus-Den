/**
 * The Discus Den website Chat Assistant: deterministic, rule-based router.
 *
 * Adapted from the FE-2 WhatsApp front-desk engine (src/lib/whatsapp/
 * front-desk.ts): same rules-first approach (normalise -> ordered intent
 * checks -> canned replies), but tuned for the public website and answered
 * from den-sales/chat-bot-sales-answers.md (answers.ts).
 *
 * Pure: state in, state out. No LLM, so "ignore your rules" style prompts
 * cannot change behaviour; they just match the prompt-attack rule.
 * Live prices come from the injected CatalogLoader (catalog.ts).
 */

import {
  ANSWERS,
  PER_PIECE_LINE,
  VOLUME_DISCOUNT_LINE,
  type LeadFlag,
} from "./answers.ts";
import type { CatalogLoader, FoodItem, StrainCard } from "./catalog.ts";
import { findPlace } from "./places.ts";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type HandoffStep = "name" | "phone" | "city" | "pairSingle" | "delivery" | "timeline";
const HANDOFF_ORDER: HandoffStep[] = ["name", "phone", "city", "pairSingle", "delivery", "timeline"];

export type LeadData = {
  name?: string;
  phone?: string;
  city?: string;
  stateName?: string;
  inShipStates?: boolean | null;
  pairSingle?: string;
  delivery?: string;
  timeline?: string;
};

export type LeadTags = {
  buyer: "hobbyist" | "reseller";
  history?: "first-timer" | "returning";
  heat?: "hot" | "warm" | "browsing";
};

export type ChatState = {
  v: 1;
  turns: number;
  /** What the last bot reply offered: a handoff, or narrowing the list. */
  pendingOffer: "handoff" | "narrow" | null;
  handoff: {
    active: boolean;
    step?: HandoffStep;
    phoneTries: number;
    nameTries: number;
    declined: HandoffStep[];
  };
  lead: LeadData;
  tags: LeadTags;
  flags: string[];
  /** Live strain names the visitor asked about (for the alert's Interest line). */
  interests: string[];
  completed: boolean;
};

export function newChatState(): ChatState {
  return {
    v: 1,
    turns: 0,
    pendingOffer: null,
    handoff: { active: false, phoneTries: 0, nameTries: 0, declined: [] },
    lead: {},
    tags: { buyer: "hobbyist" },
    flags: [],
    interests: [],
    completed: false,
  };
}

export type EngineResult = {
  reply: string;
  /** True while the handoff is collecting details, and on the turn it completes. */
  handoff: boolean;
  state: ChatState;
  intent: string;
  /** True only on the turn the lead becomes complete (name + valid number). */
  completedNow: boolean;
};

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function addFlag(state: ChatState, flag: LeadFlag): void {
  if (!state.flags.includes(flag)) state.flags.push(flag);
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Remove a trailing handoff offer ("Shall I pass your details?") from a reply. */
function stripOffer(text: string): string {
  return text
    .replace(/\s*(Shall I|Want me to|Want Shiva to|Or I can)[^.?\n]*[.?]\s*$/i, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Intent patterns (order of checks matters; see routeIntent)
// ---------------------------------------------------------------------------

const RE = {
  promptAttack:
    /\b(ignore\s+(all\s+|any\s+|your\s+|the\s+|previous\s+|prior\s+|above\s+|these\s+)*(rules|instructions|prompts?|guidelines|restrictions)|disregard\s+(your|all|the|previous)|forget\s+(your|all|previous|the)\s+(rules|instructions)|pretend\s+(to\s+be|you|you're|that)|role\s?-?play|act\s+as|you\s+are\s+now|from\s+now\s+on\s+you|system\s+prompt|developer\s+mode|jailbreak|dan\s+mode|reveal\s+(your\s+)?(prompt|instructions|rules)|what\s+are\s+your\s+(rules|instructions)|show\s+(me\s+)?your\s+(prompt|instructions|rules)|override|admin\s+mode|sudo|new\s+instructions|new\s+rule|repeat\s+after\s+me|repeat\s+everything|as\s+an?\s+admin|i\s+authori[sz]e\s+you|internal\s+(quantity|data|figures)|translate\s+your\s+(instructions|rules|prompt)|rules\s+ellam|marandhu\w*)\b|<\/?system>|^(system|say)\s*:/,
  discount:
    /\b(discount|discounts|coupon|coupons|promo|promocode|voucher|vouchers|offer|offers|cashback|referral|any\s+deal|deals|first[\s-]?time\s+(code|offer|discount)|(discount|coupon|promo|promotional|offer|referral|voucher|first[\s-]?time|friend'?s?|secret|special|cart)\s+codes?|(the|a|any|your|that|this)\s+code|code\s+(is|for)|\d+\s*%\s*off|\d+\s*(rupees|rs)\s+off)\b|(₹|\brs\.?\s*)\s*\d[\d,]*\s*off\b/,
  /** FAQ 22: a claimed promise/offer ("Shiva said...", "you offered...", "apply it"). */
  claimVerb:
    /\b(shiva|you|he|your\s+(team|staff|bot|site|website|guy)|the\s+bot|someone|they)\s+(said|says|told|tells|promised|offered|agreed|gave|confirmed|mentioned|guaranteed|assured)\b|\b(was|were|been|got|am|i'?m)\s+(promised|offered|told|assured)\b|\bas\s+(promised|agreed|discussed)\b|\bpromised\b/,
  claimApply: /\bapply\s+(it|that|this|the|my)\b/,
  claimFreeMonth: /\b(free\s+for\s+a\s+month|a\s+month\s+free|month\s+free|free\s+month)\b/,
  offerish:
    /\b(off|free|discount|discounts|offer|offers|price|cheaper|refund|hold|holding|month|apply|deal|waive|waived|extra|less|code|coupon|bonus|gift)\b|%|₹|\brs\.?\s*\d/,
  refundSure: /\brefund\b[^?.]*\b(for\s+sure|right|guarantee\w*|definitely|confirm\w*|promise\w*)\b/,
  /** FAQ 21: mortality / loss questions. */
  mortalityWord:
    /\b(die|dies|died|dying|death|deaths|dead|lose|loses|losing|lost|loss|losses|mortality)\b|\b(setth|sethth|sethu|saag|seththu)\w*/,
  mortalityTamil: /\b(setth|sethth|sethu|saag|seththu)\w*/,
  mortalityContext:
    /\b(your|you|often|many|much|lots|lot|rate|rates|ever|usually|quarantine|transit|tanks?|how\s+many|true|percent|percentage|frequently|regularly|common|evlo|ethana)\b|%/,
  mortalityPersonal:
    /\b(my|mine|our)\s+(fish|discus|order|ones?)\b|\barriv\w*|\bon\s+arrival\b|\bwhat\s+(happens\s+)?if\b|\bif\s+(a|the|my|any)\b|\bin\s+case\b|\bsuppose\b|\brefund\b|\bdoa\b/,
  sickOften: /\b(sick|ill|diseased?)\b[^?.]*\b(often|usually|frequently|common|lot)\b|\byour\s+fish\b[^?.]*\b(sick|ill|diseased?)\b/,
  /** FAQ 23: off-topic requests. */
  offTopic:
    /\b(python|javascript|typescript|java|html|css|sql|programming|coding|code\s+(for|in|to)|write\s+(me\s+)?(a\s+|an\s+|some\s+)?(code|program|script|essay|poem|story|letter|song|email|article)|homework|assignment|exam|essay|weather|forecast|raining|rain\s+today|news|headlines?|election|politics|cricket|ipl|football|movie|movies|film|recipe|joke|jokes|capital\s+of|president|prime\s+minister|bitcoin|crypto|stock\s+market|share\s+price|girlfriend|boyfriend|relationship|horoscope|astrology|translate|math|maths)\b/,
  fishCore: /\b(discus|fish|fishes|aquarium|tank|strains?|pellets?|bloodworms?|order|delivery|shipping|pickup)\b/,
  paymentConfirm:
    /\b(paid|have\s+paid|payment\s+(done|sent|made|completed)|sent\s+(the\s+)?(money|payment|amount)|transferred|did\s+you\s+(get|receive)|received\s+(my|the)\s+(payment|money)|is\s+this\s+(the\s+)?(right|correct|your)|confirm\s+(the\s+|my\s+)?(number|upi|payment|account)|gpay\s+number|upi\s+number|payment\s+number|upi\s+id|account\s+(number|details)|bank\s+details|ifsc)\b/,
  payment:
    /\b(pay|paying|payment|gpay|g\s?pay|google\s+pay|upi|phonepe|paytm|bank|cash\s+on\s+delivery|cod|advance|kaasu|panam)\b/,
  doaQuestion:
    /\b(guarantee|guaranteed|live\s+arrival|safe\s+arrival|what\s+if\s+(a|the|my)?\s*(fish\s+)?(dies|die|is\s+dead|arrives?\s+dead)|if\s+(a|the)\s+fish\s+(dies|arrives?\s+dead)|do\s+you\s+(refund|replace)|refund\s+policy|doa\s+policy)\b|\b(what\s+(happens\s+)?if|in\s+case|suppose)\b[^.?]*\b(die|dies|died|dead|doa)\b/,
  doaReport:
    /\b(died|dead|doa|passed\s+away|not\s+alive|refund|replacement|replace\s+(it|my|the))\b/,
  sick:
    /\b(sick|ill|unwell|disease|diseased|spots?|white\s+spot|not\s+eating|isn'?t\s+eating|stopped\s+eating|won'?t\s+eat|hiding|fungus|ich|bloat(ed)?|dropsy|parasites?|medicine|medication|treatment|treat|cure|salt|dying|gasping|clamped|udambu|sari\s+illa|saapdala|saapidala|saapidavillai|noi)\b/,
  internal:
    /\b(how\s+many\b[^?.]*\b(left|remaining|available|in\s+stock|do\s+you\s+have|have\s+you\s+got|pieces|units)|any\s+left|left\s+in\s+stock|stock\s+left|how\s+many\s+(fish|discus)\s+(do\s+you\s+have|are\s+there|left)|stock\s+(count|level|quantity)|quantity\s+(left|available)|mortality|death\s+rate|how\s+many\s+died|losses|supplier|suppliers|breeder|breeders|where\s+do\s+you\s+(get|source|import|buy)|source\s+farm|which\s+farm|imported?\s+from|who\s+supplies|who\s+breeds|bred\s+by|yaar\s+kitta|vaangu\w*|selling\s+fast|sold\s+out|almost\s+gone|last\s+one|only\s+(one|1|\d+)\b[^?.]*\bleft|stock\s+(is\s+)?limited|limited\s+stock|plenty|enough\s+(for|of)|that\s+many|short\s+supply|running\s+out|(evlo|evvalavu|evlavu|evalo|ethana|ethanai)\b[^?.]*\b(irukk\w*|stock|left|pieces?)|(stock|pieces?)\s+(evlo|evvalavu|ethana)\w*)\b/,
  human:
    /\b(are\s+you\s+(a\s+)?(human|person|real|bot|robot|ai|machine)|is\s+this\s+(a\s+)?(bot|human|real\s+person|ai)|am\s+i\s+(talking|chatting)\s+(to|with)|you\s+a\s+bot)\b/,
  talkToShiva:
    /\b(talk\s+to\s+shiva|speak\s+(to|with)\s+shiva|chat\s+with\s+shiva|talk\s+to\s+(a\s+)?(human|person|someone|owner)|real\s+person|contact\s+shiva|call\s+shiva|reach\s+shiva|message\s+shiva|shiva'?s?\s+(number|phone|whatsapp|contact|mobile|email)|your\s+(number|phone|whatsapp|contact|mobile|email)|phone\s+number|whatsapp\s+number|mobile\s+number|contact\s+(number|details|info)|call\s+me|call\s+back|shiva\s+kitta|pesanum|pesa\s+venum|connect\s+me|number\s+(kudunga|kudu|venum|send)|call\s+(pannanum|pannunga|panna|pannuga)|phone\s+line|business\s+(number|phone|line)|contact\s+number|your\s+contact)\b/,
  reseller:
    /\b(wholesale|wholesaler|resell|reseller|resale|dealer|distributor|trade\s+(price|enquiry|rate)|bulk\s+(order|price|rate|buy)|my\s+(shop|store)|i\s+(have|run|own)\s+(a|an)\s+(shop|store|aquarium\s+shop|pet\s+shop))\b/,
  holding:
    /\b(hold|holding|keep\s+(my|the)\s+fish|tank\s+(is\s+)?(not|isn'?t)\s+ready|not\s+ready\s+yet|reserve|keep\s+them)\b/,
  holdingBeyond:
    /\b(month|months|\d{2,}\s+days|free\s+for|longer|extend|beyond|waive|discount\s+on)\b/,
  goatHeart: /\b(goat\s*heart|ghm)\b/,
  food:
    /\b(food|foods|pellets?|frozen|bloodworms?|blood\s+worms?|heart\s+mix|beef\s*heart|buffalo\s*heart|bhm|provit)\b/,
  pairSingle: /\b(pair\s+or\s+(a\s+)?single|single\s+or\s+(a\s+)?pair|buy\s+a\s+pair|should\s+i\s+(get|buy)\s+(a\s+)?(pair|single|group))\b/,
  perPiece: /\b(per\s+(fish|piece|pair|pc)|each|for\s+a\s+pair|pair\s+price|price\s+for\s+(a\s+)?pair|is\s+(that|this|the\s+price)\s+(for\s+)?(one|a\s+pair))\b/,
  beginner: /\b(beginner|beginners|starter|first\s+(time|discus|tank)|new\s+to\s+discus|easy\s+(strain|discus|one)|hardy|good\s+for\s+(a\s+)?(beginner|start))\b/,
  shipCost:
    /\b((shipping|delivery|courier|transport|train)\s+(cost|charge|charges|fee|fees|price|rate)|how\s+much\s+(is\s+|for\s+)?(the\s+)?(shipping|delivery|courier))\b/,
  shipHow:
    /\b((when|how)\s+(do|will|would|does)\s+(you|it|they|the\s+fish)\s+(ship|deliver|dispatch|arrive|send|come)|how\s+(is|are)\s+(it|they|fish)\s+(shipped|delivered|sent)|shipping\s+(process|method|time)|delivery\s+time|how\s+long\s+(does|will)\s+(shipping|delivery))\b/,
  ship:
    /\b(ship|ships|shipping|deliver|delivery|courier|send\s+(?:\w+\s+){0,3}to|transport|parcel|anuppu\w*|anupp\w*|anupuv\w*|anuppa\w*|varuma)\b/,
  pickup: /\b(pick\s?-?up|pickup|collect\s+(in|from|at)|self\s+pick|pickup\s+irukka)\b/,
  visit:
    /\b(visit|address|location|where\s+are\s+you|where\s+is\s+(the\s+)?(den|shop|store)|timings?|opening\s+hours|hours|open\s+(today|now)|come\s+to\s+(your|the)\s+(shop|store|place|den)|your\s+(shop|store)|do\s+you\s+have\s+a\s+(shop|store))\b/,
  quarantine: /\bquarantin\w*/,
  ordering:
    /\b(how\s+(do|can|to)\s+i\s+(order|buy|purchase)|how\s+to\s+(order|buy|purchase)|ordering|place\s+(an\s+)?order|order\s+process|cart)\b/,
  care:
    /\b(care|tips|how\s+to\s+(keep|maintain|look\s+after|raise)|maintenance|water\s+change|water\s+changes|temperature|temp|ph|feeding|how\s+often|tank\s+size|tank\s+mates|setup|set\s+up)\b/,
  price:
    /\b(price|prices|pricing|cost|costs|rate|rates|how\s+much|evlo|evvalavu|evlavu|evalo|evlo\s+aagum|vilai|price\s+enna|enna\s+(price|rate|vilai)|rupees|rs|inr)\b|₹/,
  available:
    /\b(i\s+want|looking\s+for|want\s+to\s+buy|interested\s+in)\b[^?.]*\b(fish|discus|pair)\b|\b(available|availability|in\s+stock|what\s+(fish|discus|strains?)|which\s+(fish|discus|strains?)|strains?|sizes?|what\s+do\s+you\s+have|show\s+me|list|catalog|catalogue|irukka|irukku|irukkaa|iruka|iruku|enna\s+(fish|discus|stock|meen)|endha\s+(fish|discus)|fish\s+list|stock)\b/,
  greeting:
    /^(hi+|hello+|hey+|hai|hiya|vanakkam|namaste|namaskaram|good\s+(morning|afternoon|evening)|yo|hola|start)\b[\s!.?,]*$/,
  thanks: /^(thanks|thank\s+you|thx|ty|nandri|ok\s+thanks|okay\s+thanks|great\s+thanks|cool)\b[\s!.?,a-z]*$/,
  bye: /^(bye|goodbye|see\s+you|good\s+night|tata)\b[\s!.?,]*$/,
  affirm:
    /^(yes|yeah|yep|ya|yup|sure|ok|okay|please|pls|go\s+ahead|haan|aama|ama|seri|sari|definitely|of\s+course|why\s+not|do\s+it|y)\b/,
  negate: /^(no|nope|nah|not\s+now|no\s+thanks|illa|venam|vendam|later|maybe\s+later|n)\b/,
  cancel: /^(cancel|stop|forget\s+it|never\s*mind|nevermind|leave\s+it|exit|quit)\b/,
  declineField:
    /^(no|nope|skip|pass|rather\s+not|prefer\s+not|not\s+comfortable|don'?t\s+want|i\s+don'?t\s+want|no\s+thanks|na|nah|why|not\s+now|later)\b/,
  discusish:
    /\b(discus|fish|tank|aquarium|strain|water|den|tdd|shiva|order|ship|food|chennai|price|buy)\b/,
};

/** Coupon-shaped token typed by the visitor, e.g. "ABCDE10". Never echoed. */
const COUPON_TOKEN = /\b[A-Z]{3,}\d{1,4}\b|\b[a-z]{4,}\d{1,4}\b/;

const COLOURS = ["red", "blue", "yellow", "white", "gold", "golden", "orange", "green", "turquoise", "platinum", "albino", "rose", "wine", "cobalt", "lemon"];

/** Discus strain vocabulary used to spot "strain not listed" questions. */
const STRAIN_WORDS = [
  "pigeon blood", "pigeon", "heckel", "leopard", "snakeskin", "snake skin", "checkerboard", "marlboro", "melon",
  "ghost", "alenquer", "santarem", "tefe", "ivory", "stendker", "royal blue", "snow white", "white diamond",
  "red diamond", "solid red", "solid blue", "panda", "eagle", "tiger", "scorpion", "butterfly", "ninja", "curipera",
  "galaxy", "viper", "vipers", "panthera", "majestic", "checkerboards", "diamond", "diamonds", "turquoise",
  "albino", "platinum", "golden", "flower horn", "angel", "red cover", "blue face", "wild",
];

// ---------------------------------------------------------------------------
// Strain matching against the live page
// ---------------------------------------------------------------------------

function singular(w: string): string {
  if (w.length > 4 && w.endsWith("es") && !w.endsWith("ses")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}

function words(s: string): string[] {
  return norm(s)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(singular);
}

const STOP = new Set(["discu", "discus", "the", "and", "big", "small"]);

type CardKeys = { card: StrainCard; variants: string[][]; qualifier: "big" | "small" | null; bundled: boolean };

function cardKeys(card: StrainCard): CardKeys {
  const qualifier = /\((big|large)\)/i.test(card.name) ? "big" : /\(small\)/i.test(card.name) ? "small" : null;
  const base = card.name.replace(/\([^)]*\)/g, " ");
  const parts = base.split("/").map((p) => p.trim()).filter(Boolean);
  const variants = parts.map((p) => words(p).filter((w) => !STOP.has(w) && w.length >= 3));
  return { card, variants, qualifier, bundled: parts.length > 1 };
}

export type StrainMatch = { cards: StrainCard[]; bundled: boolean };

/** Match the visitor's words to live cards. Colour-only questions are handled by filterCards. */
export function matchStrains(text: string, cards: StrainCard[]): StrainMatch {
  const msg = new Set(words(text));
  const msgColours = COLOURS.filter((c) => msg.has(c));
  const keys = cards.map(cardKeys);

  // How many cards each distinctive (non-colour) word appears in.
  const freq = new Map<string, number>();
  for (const k of keys) {
    const seen = new Set(k.variants.flat().filter((w) => !COLOURS.includes(w)));
    for (const w of seen) freq.set(w, (freq.get(w) ?? 0) + 1);
  }

  const hits: Array<{ k: CardKeys; full: boolean; n: number }> = [];
  for (const k of keys) {
    let bestFull: boolean | null = null;
    let bestN = 0;
    for (const v of k.variants) {
      const nonColour = v.filter((w) => !COLOURS.includes(w));
      // Names made only of colour words (e.g. "Albino Platinum") match on all words.
      const distinct = nonColour.length ? nonColour : v;
      const colours = nonColour.length ? v.filter((w) => COLOURS.includes(w)) : [];
      if (!distinct.length) continue;
      const matched = distinct.filter((w) => msg.has(w));
      if (!matched.length) continue;
      // Colour consistency: if the visitor named a colour, it must fit the card.
      if (msgColours.length && colours.length && !colours.some((c) => msgColours.includes(c))) continue;
      const full = matched.length === distinct.length;
      const uniqueRare = matched.some((w) => (freq.get(w) ?? 0) === 1 && w.length >= 5);
      const sharedRare = matched.some((w) => w.length >= 6);
      if (full || uniqueRare || sharedRare) {
        bestFull = full || bestFull === true;
        bestN = Math.max(bestN, matched.length);
      }
    }
    if (bestFull !== null) hits.push({ k, full: bestFull, n: bestN });
  }
  // Keep the cards that matched the most of the visitor's words
  // ("snakeskin" -> both snakeskin cards; "panthera snakeskin" -> just one).
  const maxN = Math.max(0, ...hits.map((h) => h.n));
  let chosen = hits.filter((h) => h.n === maxN);

  // Big / small qualifier (e.g. "small blue diamonds").
  const wantBig = msg.has("big") || msg.has("large");
  const wantSmall = msg.has("small");
  if ((wantBig || wantSmall) && chosen.some((h) => h.k.qualifier)) {
    const q = chosen.filter((h) => h.k.qualifier === (wantBig ? "big" : "small"));
    if (q.length) chosen = q;
  }
  return { cards: chosen.map((h) => h.k.card), bundled: chosen.some((h) => h.k.bundled) };
}

function sizeRange(size: string): [number, number] | null {
  const nums = (size.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (!nums.length) return null;
  return [Math.min(...nums), Math.max(...nums)];
}

/** Filter by colour words and size ("small", "big", "3 inch"). Returns null if no filter given. */
export function filterCards(text: string, cards: StrainCard[]): StrainCard[] | null {
  const t = norm(text);
  const msg = new Set(words(text));
  const colours = COLOURS.filter((c) => msg.has(c)).map((c) => (c === "golden" ? "gold" : c));
  const inch = /(\d+(?:\.\d+)?)\s*(?:"|inch|inches|in\b)/.exec(t);
  const wantSmall = /\b(small|smaller|baby|juvenile)\b/.test(t);
  const wantBig = /\b(big|bigger|large|adult|show\s+size|breeder\s+size)\b/.test(t);
  if (!colours.length && !inch && !wantSmall && !wantBig) return null;
  // Colour: prefer cards whose NAME has the colour; fall back to descriptions.
  const byName = colours.length ? cards.filter((c) => colours.some((col) => norm(c.name).includes(col))) : cards;
  const pool = byName.length ? byName : cards;
  return pool.filter((c) => {
    const hay = norm(`${c.name} ${c.description}`);
    if (colours.length && !colours.some((col) => hay.includes(col))) return false;
    const r = sizeRange(c.size);
    if (inch && r) {
      const x = Number(inch[1]);
      if (x < r[0] - 0.25 || x > r[1] + 0.25) return false;
    }
    if (wantSmall && r && r[0] > 3) return false;
    if (wantBig && r && r[1] < 4.5) return false;
    return true;
  });
}

function cardLine(c: StrainCard): string {
  const parts = [c.name, c.size].filter(Boolean).join(", ");
  return `• ${parts}, ${c.priceText} per piece${c.description ? `: ${c.description}` : ""}`;
}

function foodLine(f: FoodItem): string {
  const packs = f.packs.map((p) => [p.size, p.priceText].filter(Boolean).join(" ")).join(", ");
  return `${f.name}: ${packs}`;
}

// ---------------------------------------------------------------------------
// Lead tagging (silent)
// ---------------------------------------------------------------------------

function updateTags(state: ChatState, t: string): void {
  if (RE.reseller.test(t)) {
    state.tags.buyer = "reseller";
    addFlag(state, "RESELLER");
  }
  if (/\b(bought\s+(from\s+you|before)|ordered\s+(from\s+you\s+)?before|previous\s+order|last\s+order|returning\s+customer|ordered\s+last|bought\s+last)\b/.test(t)) {
    state.tags.history = "returning";
  } else if (
    !state.tags.history &&
    /\b(new\s+to\s+discus|first\s+(time|purchase|discus|tank)|beginner|never\s+kept|tank\s+(is\s+)?not\s+ready|setting\s+up)\b/.test(t)
  ) {
    state.tags.history = "first-timer";
  }
  if (/\b(this\s+week|today|tomorrow|asap|urgent|right\s+away)\b/.test(t)) state.tags.heat = "hot";
  else if (!state.tags.heat && /\b(few\s+weeks|next\s+month|comparing|compare|weeks)\b/.test(t)) state.tags.heat = "warm";
}

function finalHeat(state: ChatState): "hot" | "warm" | "browsing" {
  if (state.tags.heat === "hot") return "hot";
  if (state.lead.timeline === "tank ready now" && state.interests.length) return "hot";
  if (state.tags.heat === "warm" || state.lead.timeline === "weeks" || state.interests.length > 1) return "warm";
  return "browsing";
}

// ---------------------------------------------------------------------------
// Handoff field parsers
// ---------------------------------------------------------------------------

/** Indian mobile: optional +91 / 91 / 0, then 10 digits starting 6–9. Returns +91XXXXXXXXXX. */
export function extractIndianMobile(text: string): string | null {
  const m = /(?<!\d)(?:\+?\s*91[\s-]*|0)?([6-9](?:[\s-]?\d){9})(?!\d)/.exec(text);
  if (!m) return null;
  const digits = m[1]!.replace(/\D/g, "");
  if (digits.length !== 10) return null;
  if (/^(\d)\1{7,}/.test(digits) || /(\d)\1{7,}$/.test(digits)) return null;
  if (digits === "9876543210" || digits === "6789012345") return null;
  return `+91${digits}`;
}

function digitCount(text: string): number {
  return (text.match(/\d/g) ?? []).length;
}

const NAME_BLOCK =
  /\b(list|all|leads?|show|give|repeat|details|number|admin|delete|tell|print|everyone|customers?|price|fish|discus|shiva|ignore|rules|instructions|yes|no|ok|okay|skip|tank|ship|how|what|why|where|when|available|hello|hi|hey|thanks|code|discount|pay|refund|pair|single|train|pickup|chennai|bot|prompt|system|admin)\b/i;

export function parseName(raw: string): string | null {
  let s = raw.trim().replace(/[.!]+$/, "");
  s = s.replace(/^(hi|hello|hey|vanakkam)[,!\s]+/i, "");
  const m = /^(?:my\s+name\s+is|my\s+name's|name\s+is|name:|i\s+am|i'm|im|this\s+is|it's|its|call\s+me|naan|en\s+peyar)\s+(.+)$/i.exec(s);
  if (m) s = m[1]!;
  s = s.replace(/\s*(,|\bhere\b|\bfrom\b|\band\b|\bmy\s+number\b|\+?\d).*$/i, "").trim();
  if (!s || s.length > 40) return null;
  if (!/^\p{L}[\p{L}\s.'-]*$/u.test(s)) return null;
  const parts = s.split(/\s+/);
  if (parts.length > 4) return null;
  if (NAME_BLOCK.test(s)) return null;
  return titleCase(s.toLowerCase());
}

function parsePairSingle(t: string): string | null {
  if (/\b(not\s+sure|don'?t\s+know|undecided|either|maybe)\b/.test(t)) return "not sure";
  if (/\b(pair|pairs|two|2\s*(fish|nos|pcs)?|couple)\b/.test(t)) return "pair";
  if (/\b(single|one|1\s*(fish|no|pc)?|just\s+one)\b/.test(t)) return "single";
  if (/\b(group|school|several|many|[3-9]|\d{2})\b/.test(t)) return `group (${t.slice(0, 40)})`;
  return null;
}

function parseDelivery(t: string): string | null {
  if (/\b(not\s+sure|don'?t\s+know|either|any|both)\b/.test(t)) return "not sure";
  if (/\b(train|rail|railway|ship|shipping|parcel|courier|send)\b/.test(t)) return "train shipping";
  if (/\b(pick\s?-?up|pickup|collect|come\s+(and\s+)?(take|get)|chennai)\b/.test(t)) return "Chennai pickup";
  return null;
}

function parseTimeline(t: string): string | null {
  if (/\b(not\s+sure|don'?t\s+know|no\s+idea)\b/.test(t)) return "not sure";
  if (/\b(weeks?|months?|soon|later|setting\s+up|not\s+(yet\s+)?ready|few\s+days|cycling)\b/.test(t)) return "weeks";
  if (/\b(ready|now|already|set\s+up|cycled|yes|yep|running|established)\b/.test(t)) return "tank ready now";
  return null;
}

function looksLikeAnswer(step: HandoffStep, raw: string, t: string): boolean {
  switch (step) {
    case "name":
      return parseName(raw) !== null;
    case "phone":
      return extractIndianMobile(raw) !== null || digitCount(raw) >= 7;
    case "city":
      return findPlace(t) !== null || (!raw.includes("?") && t.split(" ").length <= 4 && /^[\p{L}\s.,'-]+$/u.test(raw.trim()));
    case "pairSingle":
      return parsePairSingle(t) !== null;
    case "delivery":
      return parseDelivery(t) !== null;
    case "timeline":
      return parseTimeline(t) !== null;
  }
}

function applyCity(state: ChatState, raw: string, t: string): void {
  const place = findPlace(t);
  const cleaned = raw.trim().replace(/[^\p{L}\s.,'-]/gu, "").slice(0, 60).trim();
  state.lead.city = cleaned || (place ? titleCase(place.name) : raw.trim().slice(0, 60));
  if (place) {
    state.lead.stateName = place.state;
    state.lead.inShipStates = place.zone === "in";
    if (place.zone !== "in") addFlag(state, "OUTSIDE 8 STATES");
    if (place.zone === "remote" || place.zone === "abroad") addFlag(state, "REMOTE");
  } else {
    state.lead.inShipStates ??= null;
  }
}

/** Opportunistic fill: skip any field the visitor already gave. */
function prefillFromMessage(state: ChatState, raw: string, t: string): void {
  const lead = state.lead;
  if (!lead.phone) {
    const phone = extractIndianMobile(raw);
    if (phone) lead.phone = phone;
  }
  if (!lead.city) {
    const place = findPlace(t);
    if (place && /\b(in|from|at|live|stay|staying|based)\b/.test(t)) {
      lead.city = titleCase(place.name);
      lead.stateName = place.state;
      lead.inShipStates = place.zone === "in";
      if (place.zone !== "in") addFlag(state, "OUTSIDE 8 STATES");
      if (place.zone === "remote" || place.zone === "abroad") addFlag(state, "REMOTE");
    }
  }
  if (!lead.pairSingle && /\b(a\s+pair|pair\s+of|single\s+fish|one\s+fish)\b/.test(t)) {
    lead.pairSingle = /\bpair\b/.test(t) ? "pair" : "single";
  }
  if (!lead.delivery && /\b(train\s+shipping|by\s+train|chennai\s+pickup|pick\s?up\s+in\s+chennai)\b/.test(t)) {
    lead.delivery = /\btrain\b/.test(t) ? "train shipping" : "Chennai pickup";
  }
  if (!lead.timeline && /\btank\s+(is\s+)?(ready|cycled|set\s+up)\b/.test(t)) lead.timeline = "tank ready now";
}

function nextStep(state: ChatState): HandoffStep | null {
  for (const step of HANDOFF_ORDER) {
    if (state.handoff.declined.includes(step)) continue;
    if (step === "delivery" && state.lead.inShipStates === false) continue;
    if (!state.lead[step]) return step;
  }
  return null;
}

function askFor(step: HandoffStep, state: ChatState): string {
  switch (step) {
    case "name":
      return ANSWERS.handoffAskName;
    case "phone":
      return ANSWERS.handoffAskPhone(state.lead.name);
    case "city":
      return ANSWERS.handoffAskCity;
    case "pairSingle":
      return ANSWERS.handoffAskPairSingle;
    case "delivery":
      return ANSWERS.handoffAskDelivery;
    case "timeline":
      return ANSWERS.handoffAskTimeline;
  }
}

type Turn = { reply: string; intent: string; completedNow?: boolean };

function finishHandoff(state: ChatState): Turn {
  state.handoff.active = false;
  state.handoff.step = undefined;
  state.pendingOffer = null;
  state.tags.heat = finalHeat(state);
  if (state.lead.name && state.lead.phone) {
    state.completed = true;
    return { reply: ANSWERS.handoffClose(state.lead.name), intent: "handoff_complete", completedNow: true };
  }
  if (state.lead.phone && !state.lead.name) {
    return { reply: ANSWERS.handoffNoName, intent: "handoff_incomplete" };
  }
  return { reply: ANSWERS.handoffNoNumber, intent: "handoff_incomplete" };
}

function advance(state: ChatState, prefix?: string): Turn {
  // Phone given but name declined once: ask for the name one more time.
  if (state.lead.phone && !state.lead.name && state.handoff.declined.includes("name") && state.handoff.nameTries < 2 && !nextStepAfterName(state)) {
    state.handoff.nameTries += 1;
    state.handoff.declined = state.handoff.declined.filter((s) => s !== "name");
    state.handoff.step = "name";
    return { reply: join(prefix, ANSWERS.handoffNeedName), intent: "handoff" };
  }
  const step = nextStep(state);
  if (!step) {
    const done = finishHandoff(state);
    return { ...done, reply: join(prefix, done.reply) };
  }
  state.handoff.step = step;
  return { reply: join(prefix, askFor(step, state)), intent: "handoff" };
}

function nextStepAfterName(state: ChatState): HandoffStep | null {
  for (const step of HANDOFF_ORDER) {
    if (step === "name") continue;
    if (state.handoff.declined.includes(step)) continue;
    if (step === "delivery" && state.lead.inShipStates === false) continue;
    if (!state.lead[step]) return step;
  }
  return null;
}

function join(...parts: Array<string | undefined>): string {
  return parts.filter((p) => p && p.trim()).join("\n\n");
}

function startHandoff(state: ChatState, raw: string, prefix?: string): Turn {
  if (state.completed) {
    state.pendingOffer = null;
    return { reply: join(prefix, ANSWERS.handoffAlreadyDone), intent: "handoff_already_done" };
  }
  state.handoff.active = true;
  state.handoff.phoneTries = 0;
  state.handoff.declined = [];
  state.pendingOffer = null;
  prefillFromMessage(state, raw, norm(raw));
  return advance(state, prefix);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

type Ctx = { catalog: CatalogLoader };

async function liveStrains(ctx: Ctx): Promise<StrainCard[] | null> {
  try {
    const cards = await ctx.catalog.strains();
    return cards ? cards.filter((c) => c.available) : null;
  } catch {
    return null;
  }
}

function strainWordsIn(t: string): string[] {
  const hits: string[] = [];
  for (const w of STRAIN_WORDS) {
    if (new RegExp(`\\b${w}\\b`).test(t) && !hits.some((h) => h.includes(w))) hits.push(w);
  }
  return hits;
}

async function priceOrAvailability(state: ChatState, raw: string, t: string, ctx: Ctx, kind: "price" | "available" | "strain"): Promise<Turn | null> {
  const cards = await liveStrains(ctx);
  if (!cards) {
    state.pendingOffer = "handoff";
    return { reply: ANSWERS.liveFetchFailed, intent: `${kind}_fallback` };
  }

  const match = matchStrains(raw, cards);
  // A strain word the matched cards don't carry (e.g. "leopard") means the visitor
  // is asking about something that isn't on the page.
  const chosenWords = new Set(match.cards.flatMap((c) => words(c.name)));
  const unmatchedVocab = strainWordsIn(t)
    .filter((w) => !COLOURS.includes(w))
    .filter((w) => !w.split(" ").every((x) => chosenWords.has(singular(x))));
  if (match.cards.length && !unmatchedVocab.length) {
    for (const c of match.cards) if (!state.interests.includes(c.name)) state.interests.push(c.name);
    const lines = match.cards.slice(0, 5).map(cardLine).join("\n");
    const extra = [ANSWERS.shippingExtra, VOLUME_DISCOUNT_LINE];
    if (match.bundled) {
      state.pendingOffer = "handoff";
      return { reply: join(lines, extra.join(" "), ANSWERS.bundledVariant), intent: `${kind}_strain` };
    }
    state.pendingOffer = null;
    return { reply: join(lines, extra.join(" ")), intent: `${kind}_strain` };
  }

  // Named a discus strain that isn't on the page right now.
  const vocab = match.cards.length ? unmatchedVocab : strainWordsIn(t).filter((w) => !COLOURS.includes(w));
  if (vocab.length) {
    addFlag(state, `STRAIN NOT LISTED: ${vocab.join(" ")}`.slice(0, 80) as LeadFlag);
    state.pendingOffer = "handoff";
    return { reply: ANSWERS.strainNotListedAsk, intent: "strain_not_listed" };
  }
  if (kind === "strain") return null;

  const filtered = filterCards(raw, cards);
  if (filtered && !filtered.length) {
    state.pendingOffer = "handoff";
    return {
      reply: "Nothing on our available page matches that right now. Full list: thediscusden.com/available. Want me to ask Shiva about it?",
      intent: "available_filtered_none",
    };
  }
  const list = (filtered ?? cards).slice(0, 5);
  const head = kind === "price" ? `${PER_PIECE_LINE} ${ANSWERS.availableIntro}` : ANSWERS.availableIntro;
  state.pendingOffer = "narrow";
  return {
    reply: join(`${head}\n${list.map(cardLine).join("\n")}`, `${VOLUME_DISCOUNT_LINE}\n${ANSWERS.availableOutro}`),
    intent: filtered ? `${kind}_filtered` : `${kind}_list`,
  };
}

async function foodAnswer(state: ChatState, ctx: Ctx, goat: boolean): Promise<Turn> {
  let foods: { frozen: FoodItem[] | null; pellets: FoodItem[] | null };
  try {
    foods = await ctx.catalog.foods();
  } catch {
    foods = { frozen: null, pellets: null };
  }
  if (goat) {
    const ghm = foods.frozen?.find((f) => /goat\s*heart/i.test(f.name));
    if (ghm && ghm.packs.length) {
      state.pendingOffer = null;
      return { reply: `${foodLine(ghm)}. ${ANSWERS.foodOutro}`, intent: "food_goat_live" };
    }
    state.pendingOffer = "handoff";
    return { reply: ANSWERS.goatHeartPending, intent: "food_goat_pending" };
  }
  if (!foods.frozen && !foods.pellets) {
    state.pendingOffer = "handoff";
    return { reply: ANSWERS.foodFetchFailed, intent: "food_fallback" };
  }
  const frozen = (foods.frozen ?? []).filter((f) => f.packs.length);
  const pellets = (foods.pellets ?? []).filter((f) => f.packs.length);
  const pending = (foods.frozen ?? []).some((f) => /goat\s*heart/i.test(f.name) && !f.packs.length);
  const parts: string[] = [];
  if (frozen.length) parts.push(`frozen foods (${frozen.map(foodLine).join("; ")})`);
  if (pellets.length) parts.push(pellets.map(foodLine).join("; "));
  if (!parts.length) {
    state.pendingOffer = "handoff";
    return { reply: ANSWERS.foodFetchFailed, intent: "food_fallback" };
  }
  state.pendingOffer = null;
  const reply = `${ANSWERS.foodIntro} ${parts.join(" and ")}.${pending ? " Goat Heart Mix rates are coming soon." : ""} ${ANSWERS.foodOutro}`;
  return { reply, intent: "food_live" };
}

async function beginnerAnswer(state: ChatState, ctx: Ctx): Promise<Turn> {
  state.tags.history ??= "first-timer";
  const cards = await liveStrains(ctx);
  const yd = cards?.find((c) => /^yellow diamonds?$/i.test(c.name.trim()));
  state.pendingOffer = "handoff";
  if (!yd) return { reply: ANSWERS.beginnerNotListed, intent: "beginner_handoff" };
  if (!state.interests.includes(yd.name)) state.interests.push(yd.name);
  return {
    reply: `${ANSWERS.beginnerIntro} ${yd.name}: ${yd.size}, ${yd.priceText} per piece.${yd.description ? ` ${yd.description.replace(/([^.!?])$/, "$1.")}` : ""} ${ANSWERS.beginnerOutro}`,
    intent: "beginner",
  };
}

function shippingAnswer(state: ChatState, t: string): Turn {
  const place = findPlace(t);
  if (place) {
    state.lead.stateName ??= place.state;
    if (place.zone === "in") {
      state.pendingOffer = null;
      return { reply: ANSWERS.shipInStates, intent: "ship_in_states" };
    }
    addFlag(state, "OUTSIDE 8 STATES");
    state.pendingOffer = "handoff";
    if (place.zone === "other") return { reply: ANSWERS.shipOtherState, intent: "ship_other_state" };
    addFlag(state, "REMOTE");
    if (place.zone === "remote") return { reply: ANSWERS.shipRemote, intent: "ship_remote" };
    return { reply: ANSWERS.shipAbroad, intent: "ship_abroad" };
  }
  state.pendingOffer = null;
  return { reply: ANSWERS.shipInStates, intent: "ship_general" };
}

/** Normal (non-handoff) routing. Returns null when nothing matched. */
async function routeIntent(state: ChatState, raw: string, t: string, ctx: Ctx): Promise<Turn> {
  // --- Safety first: these always win, whatever else the message says. ---
  if (RE.promptAttack.test(t)) {
    state.pendingOffer = null;
    return { reply: ANSWERS.promptAttack, intent: "prompt_attack" };
  }
  // FAQ 23: off-topic (code, weather, news, homework...). Don't attempt it, don't fall back to an FAQ.
  if (RE.offTopic.test(t) && !RE.fishCore.test(t) && !/\b(discount|coupon|promo|offers?|first[\s-]?time|voucher|referral|cart)\b/.test(t)) {
    state.pendingOffer = null;
    return { reply: ANSWERS.offTopic, intent: "off_topic" };
  }
  // FAQ 22: claimed promises/offers win over holding (FAQ 14) and discounts (FAQ 19).
  const isQuestionAsk = /^(can|could|will|would|do|does|is|any|how)\b/.test(t);
  if (
    (RE.claimVerb.test(t) && RE.offerish.test(t)) ||
    RE.claimApply.test(t) ||
    (RE.claimFreeMonth.test(t) && !isQuestionAsk) ||
    RE.refundSure.test(t)
  ) {
    addFlag(state, "CLAIMED OFFER");
    if (/\b(hold|holding|month)\b/.test(t)) addFlag(state, "LONG HOLD");
    if (RE.refundSure.test(t)) addFlag(state, "GUARANTEE ASKED");
    if (/\b(off|free|discount|offer|cheaper|less|code|coupon|bonus|gift|waive\w*)\b|%|₹|\brs\.?\s*\d/.test(t)) addFlag(state, "DISCOUNT ASKED");
    state.pendingOffer = "handoff";
    return { reply: ANSWERS.claimedOffer, intent: "claimed_offer" };
  }
  // FAQ 21: mortality. Neutral, never yes/no, never numbers.
  if (
    (RE.mortalityWord.test(t) && (RE.mortalityTamil.test(t) || /\bmortality\b|\bloss(es)?\s+rate\b|\bdeath\s+rate\b/.test(t) || (RE.mortalityContext.test(t) && !RE.mortalityPersonal.test(t)))) ||
    RE.sickOften.test(t)
  ) {
    addFlag(state, "MORTALITY ASKED");
    state.pendingOffer = "handoff";
    return { reply: ANSWERS.mortality, intent: "mortality" };
  }
  if (RE.discount.test(t) || COUPON_TOKEN.test(raw)) {
    addFlag(state, "DISCOUNT ASKED");
    state.pendingOffer = "handoff";
    return { reply: `${ANSWERS.discount}\n\n${VOLUME_DISCOUNT_LINE}`, intent: "discount" };
  }
  if (RE.paymentConfirm.test(t) || (RE.payment.test(t) && (digitCount(raw) >= 6 || /@/.test(raw)))) {
    addFlag(state, "PAYMENT ASKED");
    state.pendingOffer = null;
    return { reply: ANSWERS.paymentDetails, intent: "payment_details" };
  }
  if (RE.doaQuestion.test(t)) {
    addFlag(state, "GUARANTEE ASKED");
    state.pendingOffer = null;
    return { reply: ANSWERS.doa, intent: "doa_policy" };
  }
  if (RE.doaReport.test(t)) {
    addFlag(state, "DOA CLAIM");
    return startHandoff(state, raw, ANSWERS.doa);
  }
  if (RE.sick.test(t)) {
    addFlag(state, "SICK FISH");
    state.pendingOffer = "handoff";
    return { reply: ANSWERS.sickFish, intent: "sick_fish" };
  }
  if (RE.internal.test(t)) {
    state.pendingOffer = "narrow";
    return { reply: ANSWERS.noInternalFigures, intent: "internal_figures" };
  }
  if (RE.human.test(t)) {
    state.pendingOffer = null;
    return { reply: ANSWERS.areYouHuman, intent: "are_you_human" };
  }
  if (RE.talkToShiva.test(t)) {
    return startHandoff(state, raw);
  }

  // --- Offers from the previous reply ---
  const shortReply = t.split(" ").length <= 5;
  if (state.pendingOffer === "handoff" && RE.affirm.test(t) && shortReply) {
    return startHandoff(state, raw);
  }
  if (state.pendingOffer && RE.negate.test(t) && shortReply) {
    state.pendingOffer = null;
    return { reply: ANSWERS.handoffDeclined, intent: "offer_declined" };
  }
  if (state.pendingOffer === "narrow" && RE.affirm.test(t) && !RE.available.test(t) && !COLOURS.some((c) => t.includes(c))) {
    state.pendingOffer = "narrow";
    return { reply: "Sure. Which size or colour would you like?", intent: "narrow_ask" };
  }

  // --- FAQs ---
  if (RE.reseller.test(t)) {
    state.pendingOffer = "handoff";
    return { reply: ANSWERS.reseller, intent: "reseller" };
  }
  if (RE.holding.test(t) && !RE.ship.test(t)) {
    state.tags.history ??= "first-timer";
    if (RE.holdingBeyond.test(t)) {
      addFlag(state, "LONG HOLD");
      state.pendingOffer = "handoff";
      return { reply: `${ANSWERS.holding} ${ANSWERS.holdingBeyond}`, intent: "holding_beyond" };
    }
    state.pendingOffer = null;
    return { reply: ANSWERS.holding, intent: "holding" };
  }
  if (RE.goatHeart.test(t)) return foodAnswer(state, ctx, true);
  if (RE.food.test(t)) return foodAnswer(state, ctx, false);
  if (RE.pairSingle.test(t)) {
    state.pendingOffer = "handoff";
    return { reply: ANSWERS.pairOrSingle, intent: "pair_or_single" };
  }
  if (RE.perPiece.test(t) && RE.price.test(t) === false && !matchAny(raw)) {
    state.pendingOffer = null;
    return { reply: `${PER_PIECE_LINE} ${VOLUME_DISCOUNT_LINE}`, intent: "per_piece" };
  }
  if (RE.beginner.test(t) && /\b(strain|which|what|suggest|recommend|good|best|start|fish|discus)\b/.test(t)) {
    return beginnerAnswer(state, ctx);
  }
  if (RE.shipCost.test(t)) {
    state.pendingOffer = null;
    return { reply: ANSWERS.shippingCost, intent: "ship_cost" };
  }
  if (RE.pickup.test(t)) {
    state.lead.delivery ??= "Chennai pickup";
    state.pendingOffer = "handoff";
    return { reply: ANSWERS.pickup, intent: "pickup" };
  }
  if (RE.shipHow.test(t) && !findPlace(t)) {
    state.pendingOffer = null;
    return { reply: ANSWERS.shippingHow, intent: "ship_how" };
  }
  if (RE.ship.test(t)) return shippingAnswer(state, t);
  if (RE.visit.test(t)) {
    state.pendingOffer = "handoff";
    return { reply: ANSWERS.visit, intent: "visit" };
  }
  if (RE.quarantine.test(t)) {
    state.pendingOffer = null;
    return { reply: ANSWERS.quarantine, intent: "quarantine" };
  }
  if (RE.ordering.test(t)) {
    state.pendingOffer = null;
    return { reply: ANSWERS.ordering, intent: "ordering" };
  }
  if (RE.payment.test(t)) {
    state.pendingOffer = null;
    return { reply: ANSWERS.howToPay, intent: "how_to_pay" };
  }
  if (RE.price.test(t)) {
    if (RE.perPiece.test(t) && !matchAny(raw)) {
      state.pendingOffer = null;
      return { reply: `${PER_PIECE_LINE} ${VOLUME_DISCOUNT_LINE}`, intent: "per_piece" };
    }
    return (await priceOrAvailability(state, raw, t, ctx, "price"))!;
  }
  if (RE.available.test(t)) return (await priceOrAvailability(state, raw, t, ctx, "available"))!;
  if (RE.care.test(t)) {
    state.pendingOffer = "handoff";
    return { reply: ANSWERS.careTips, intent: "care_tips" };
  }

  // A strain, colour or size named on its own ("yellow diamonds?", "red ones", "any 5 inch?").
  const sizeAsk = /(\d+(?:\.\d+)?)\s*(?:"|inch|inches)|\b(small|big|large|adult|juvenile)\s+(ones?|fish|discus|size)\b/.test(t);
  if (strainWordsIn(t).length || sizeAsk || COLOURS.some((c) => new RegExp(`\\b${c}\\b`).test(t))) {
    const r = await priceOrAvailability(state, raw, t, ctx, sizeAsk || COLOURS.some((c) => t.includes(c)) ? "available" : "strain");
    if (r) return r;
  }

  // Contact details typed out of the blue: start the handoff with them prefilled.
  if (extractIndianMobile(raw)) return startHandoff(state, raw);
  if (/^(my\s+name\s+is|i\s+am|i'm|this\s+is)\s+/i.test(raw) && parseName(raw) && !findPlace(t)) {
    state.lead.name = parseName(raw)!;
    state.pendingOffer = null;
    return { reply: `Thanks, ${state.lead.name}. How can I help?`, intent: "name_given" };
  }

  // Self-location ("I'm in Delhi", "I live in Pune") answers "do you ship to my city?".
  // A city name on its own (or inside an unrelated question) does not.
  if (findPlace(t) && /\b(i'?m|i\s+am|we\s+are|i\s+live|we\s+live|living|staying|based|from)\b|\b(la|le)\s+irukk\w*/.test(t)) {
    return shippingAnswer(state, t);
  }

  // --- Small talk ---
  if (RE.greeting.test(t)) {
    state.pendingOffer = null;
    return { reply: ANSWERS.welcome, intent: "welcome" };
  }
  if (RE.thanks.test(t)) {
    state.pendingOffer = null;
    return { reply: ANSWERS.thanks, intent: "thanks" };
  }
  if (RE.bye.test(t)) {
    state.pendingOffer = null;
    return { reply: ANSWERS.bye, intent: "bye" };
  }
  if (RE.affirm.test(t) || RE.negate.test(t)) {
    state.pendingOffer = null;
    return { reply: ANSWERS.handoffDeclined, intent: "ack" };
  }

  // --- Not covered: discus-ish -> offer handoff; otherwise redirect. ---
  if (RE.discusish.test(t)) {
    // FAQ 24: clarify instead of "I'm not sure".
    state.pendingOffer = null;
    return { reply: ANSWERS.unclear, intent: "unclear" };
  }
  state.pendingOffer = null;
  return { reply: ANSWERS.offTopic, intent: "off_topic" };
}

/** Cheap check used before deciding a per-piece question is generic. */
function matchAny(raw: string): boolean {
  return strainWordsIn(norm(raw)).length > 0;
}

async function handoffTurn(state: ChatState, raw: string, t: string, ctx: Ctx): Promise<Turn> {
  const step = state.handoff.step ?? nextStep(state) ?? "name";
  state.handoff.step = step;

  if (RE.cancel.test(t)) {
    state.handoff.active = false;
    state.handoff.step = undefined;
    state.pendingOffer = null;
    return { reply: ANSWERS.handoffDeclined, intent: "handoff_cancelled" };
  }

  const answered = looksLikeAnswer(step, raw, t);

  // A question instead of an answer: answer it, then re-ask the same field.
  // Prompt attacks and other safety rules always take this path.
  if (!answered && !RE.declineField.test(t)) {
    const probe = newProbe(state);
    const r = await routeIntent(probe, raw, t, ctx);
    const generic = ["unsure", "unclear", "off_topic", "ack", "welcome", "thanks"].includes(r.intent);
    const isCity = step === "city"; // free-text city names fall through to accept below
    if (!generic && !(isCity && r.intent === "off_topic")) {
      // Keep flags/tags/interests learnt from the probe, but stay in the handoff.
      state.flags = probe.flags;
      state.tags = probe.tags;
      state.interests = probe.interests;
      if (probe.handoff.active || r.intent.startsWith("handoff")) {
        const side = r.reply.replace(ANSWERS.handoffAlreadyDone, "").trim();
        return { reply: join(side, askFor(step, state)), intent: "handoff" };
      }
      return { reply: join(stripOffer(r.reply), askFor(step, state)), intent: `${r.intent}+handoff` };
    }
    if (r.intent === "prompt_attack") {
      return { reply: join(r.reply, askFor(step, state)), intent: "prompt_attack+handoff" };
    }
  }

  // Treat as an answer to the current field.
  prefillFromMessage(state, raw, t);
  switch (step) {
    case "name": {
      const name = parseName(raw);
      if (name) {
        state.lead.name = name;
      } else if (!RE.declineField.test(t) && state.handoff.nameTries < 1) {
        // Not a usable name (and not a refusal): ask once more.
        state.handoff.nameTries += 1;
        return { reply: ANSWERS.handoffAskName, intent: "handoff_name_retry" };
      } else if (!state.handoff.declined.includes("name")) {
        state.handoff.declined.push("name");
      }
      break;
    }
    case "phone": {
      const phone = extractIndianMobile(raw);
      if (phone) {
        state.lead.phone = phone;
      } else {
        state.handoff.phoneTries += 1;
        if (state.handoff.phoneTries < 2) {
          return { reply: ANSWERS.handoffPhoneRetry, intent: "handoff_phone_retry" };
        }
        state.handoff.declined.push("phone");
      }
      break;
    }
    case "city": {
      if (RE.declineField.test(t) && !findPlace(t)) state.handoff.declined.push("city");
      else applyCity(state, raw, t);
      break;
    }
    case "pairSingle": {
      const v = parsePairSingle(t);
      if (v) state.lead.pairSingle = v;
      else if (RE.declineField.test(t)) state.handoff.declined.push("pairSingle");
      else state.lead.pairSingle = raw.trim().slice(0, 60);
      break;
    }
    case "delivery": {
      const v = parseDelivery(t);
      if (v) state.lead.delivery = v;
      else if (RE.declineField.test(t)) state.handoff.declined.push("delivery");
      else state.lead.delivery = raw.trim().slice(0, 60);
      break;
    }
    case "timeline": {
      const v = parseTimeline(t);
      if (v) state.lead.timeline = v;
      else if (RE.declineField.test(t)) state.handoff.declined.push("timeline");
      else state.lead.timeline = raw.trim().slice(0, 60);
      break;
    }
  }
  return advance(state);
}

/** A disposable copy for answering a side question during the handoff. */
function newProbe(state: ChatState): ChatState {
  const copy = structuredClone(state);
  copy.handoff = { active: false, phoneTries: 0, nameTries: 0, declined: [] };
  copy.pendingOffer = null;
  copy.completed = true; // never re-start a handoff from inside a handoff
  return copy;
}

/**
 * Process one visitor message.
 * The caller persists `state` and runs the reply through guardReply().
 */
export async function respond(prev: ChatState | null | undefined, message: string, ctx: Ctx): Promise<EngineResult> {
  const state: ChatState = prev && prev.v === 1 ? structuredClone(prev) : newChatState();
  const raw = String(message ?? "").trim();
  const t = norm(raw);
  state.turns += 1;
  updateTags(state, t);

  const turn = state.handoff.active ? await handoffTurn(state, raw, t, ctx) : await routeIntent(state, raw, t, ctx);

  return {
    reply: turn.reply,
    handoff: state.handoff.active || Boolean(turn.completedNow),
    state,
    intent: turn.intent,
    completedNow: Boolean(turn.completedNow),
  };
}
