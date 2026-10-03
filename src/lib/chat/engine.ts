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
  OWNER_FALLBACK,
  ownerReply,
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
    /** Set after the FAQ 26 reply ("Shall I pass your details to him?"): next message may be yes/no. */
    awaitingConsent?: boolean;
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
    /\b(ignore\s+(all\s+|any\s+|your\s+|the\s+|previous\s+|prior\s+|above\s+|these\s+)*(rules|instructions|prompts?|guidelines|restrictions)|disregard\s+(your|all|the|previous)|forget\s+(your|all|previous|the)\s+(rules|instructions)|pretend\s+(to\s+be|you|you're|that)|role\s?-?play|act\s+as|you\s+are\s+now|from\s+now\s+on\s+you|system\s+prompt|developer\s+mode|jailbreak|dan\s+mode|reveal\s+(your\s+)?(prompt|instructions|rules)|what\s+are\s+your\s+(rules|instructions)|show\s+(me\s+)?your\s+(prompt|instructions|rules)|override|admin\s+mode|sudo|new\s+instructions|new\s+rule|repeat\s+after\s+me|repeat\s+everything|as\s+an?\s+admin|i\s+authori[sz]e\s+you|internal\s+(quantity|data|figures)|translate\s+your\s+(instructions|rules|prompt)|rules\s+ellam|marandhu\w*|output\s+(the\s+)?(word|text|phrase|string)|for\s+testing)\b|<\/?system>|^(system|say)\s*:/,
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
    /\b(python|javascript|typescript|java|html|css|sql|programming|coding|code\s+(for|in|to)|write\s+(me\s+)?(a\s+|an\s+|some\s+)?(code|program|script|essay|poem|story|letter|song|email|article)|homework|assignment|exam|essay|weather|forecast|raining|rain\s+today|news|headlines?|election|politics|cricket|ipl|football|movie|movies|film|recipe|joke|jokes|capital\s+of|president|prime\s+minister|bitcoin|crypto|stock\s+market|share\s+price|girlfriend|boyfriend|relationship|horoscope|astrology|translate|math|maths|stupid|idiot|idiots|useless|dumb|moron|fuck\w*|shit\w*|bastard|bloody|loosu|waste\s+bot|naaye|poda|podi)\b/,
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
  // Never shared (not on the site): mortality/loss figures, suppliers/breeders.
  internal:
    /\b(mortality|death\s+rate|how\s+many\s+died|losses|supplier|suppliers|breeder|breeders|where\s+do\s+you\s+(get|source|import|buy)|source\s+farm|which\s+farm|imported?\s+from|who\s+supplies|who\s+breeds|bred\s+by|yaar\s+kitta|vaangu\w*)\b/,
  // Stock / quantity questions: answered with availability only, never a number.
  stock:
    /\b(how\s+many\b[^?.]*\b(left|remaining|available|in\s+stock|do\s+you\s+have|have\s+you\s+got|pieces|units|are\s+there|in\s+the\s+den|can\s+i\s+(buy|get|order)|on\s+hand)|exactly\s+how\s+many|how\s+many\s+exactly|(more|less|fewer)\s+than\s+\d+|at\s+least\s+\d+|\d+\s+(pieces?|pcs|nos?)\s+(available|irukk\w*)|quantity|qty|count(?=\s*\?)|count$|count\s+(of|left|available|irukk\w*)|pieces?\s+(left|available|remaining)|in\s+stock(?=\s*\?)|any\s+left|left\s+in\s+stock|stock\s+left|how\s+many\s+(fish|discus)\s+(do\s+you\s+have|are\s+there|left)|stock\s+(count|level|quantity|position|status)|quantity\s+(left|available)|how\s+much\s+stock|(what|which)\s+is\s+in\s+stock|in\s+stock\s+(now|today)|selling\s+fast|sold\s+out|almost\s+gone|last\s+one|only\s+(one|1|\d+)\b[^?.]*\bleft|\w+\s+left\s*\?|stock\s+(is\s+)?limited|limited\s+stock|plenty|enough\s+(for|of)|that\s+many|short\s+supply|running\s+out|(evlo|evvalavu|evlavu|evalo|ethana|ethanai)\b[^?.]*\b(irukk\w*|stock|left|pieces?|piece|fish)|(stock|pieces?)\s+(evlo|evvalavu|ethana)\w*)\b/,
  // Who owns / runs the Den (the site footer names the owner).
  owner:
    /\b(who\s+(is|'s|s)\s+(the\s+)?(owner|proprietor|founder|boss|person\s+behind|man\s+behind|guy\s+behind)|who\s+owns|who\s+runs|who\s+(started|founded|is\s+running|is\s+behind)\s+(the\s+den|this|the\s+(shop|store|business))|owner('?s)?\s+name|name\s+of\s+the\s+owner|are\s+you\s+the\s+owner|whose\s+(shop|store|business)|owner\s+(yaar|yaaru|evar)|(yaar|yaaru)\s+owner)\b/,
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
    /\b(food|foods|pellets?|frozen|bloodworms?|blood\s+worms?|heart\s+mix|beef\s*heart|buffalo\s*heart|bhm|provit|feed|what\s+to\s+feed|saapadu)\b/,
  pairSingle: /\b(pair\s+or\s+(a\s+)?single|single\s+or\s+(a\s+)?pair|buy\s+a\s+pair|should\s+i\s+(get|buy)\s+(a\s+)?(pair|single|group))\b/,
  perPiece: /\b(per\s+(fish|piece|pair|pc)|each|for\s+a\s+pair|pair\s+price|price\s+for\s+(a\s+)?pair|is\s+(that|this|the\s+price)\s+(for\s+)?(one|a\s+pair))\b/,
  beginner: /\b(beginner|beginners|starter|first\s+(time|discus|tank)|new\s+to\s+discus|easy\s+(strain|discus|one)|hardy|good\s+for\s+(a\s+)?(beginner|start))\b/,
  shipCost:
    /\b((shipping|delivery|courier|transport|train)\s+(cost|charge|charges|fee|fees|price|rate)|how\s+much\s+(is\s+|for\s+)?(the\s+)?(shipping|delivery|courier)|(shipping|delivery|courier)\s+(is\s+)?(included|extra|free|charged)|includ\w*\b[^?.]*\b(shipping|delivery|courier)|(shipping|delivery)\s+(charge|cost)s?\s+(extra|included))\b/,
  shipHow:
    /\b((when|how)\s+(do|will|would|does)\s+(you|it|they|the\s+fish)\s+(ship|deliver|dispatch|arrive|send|come)|how\s+(is|are)\s+(it|they|fish)\s+(shipped|delivered|sent)|shipping\s+(process|method|time)|delivery\s+time|how\s+long\s+(does|will)\s+(shipping|delivery))\b/,
  ship:
    /\b(ship|ships|shipping|deliver|delivery|courier|send\s+(?:\w+\s+){0,3}to|transport|parcel|anuppu\w*|anupp\w*|anupuv\w*|anuppa\w*|varuma)\b/,
  pickup: /\b(pick\s?-?up|pickup|collect\s+(in|from|at)|self\s+pick|pickup\s+irukka)\b/,
  visit:
    /\b(visit|address|location|where\s+are\s+you|where\s+is\s+(the\s+)?(den|shop|store)|timings?|opening\s+hours|hours|open\s+(today|now)|come\s+to\s+(your|the)\s+(shop|store|place|den)|come\s+(and\s+|to\s+)?(see|check|look\s+at|view)|see\s+(the\s+|your\s+|them\s+)?(fish\s+)?(in\s+person|before\s+(buying|i\s+buy|ordering))|in\s+person|before\s+buying|your\s+(shop|store)|do\s+you\s+have\s+a\s+(shop|store))\b/,
  quarantine:
    /\bquarantin\w*|\b(are|is)\s+(the\s+|your\s+|these\s+)?(fish|discus)\s+(healthy|in\s+good\s+health|disease[\s-]?free|strong)\b|\bhealthy\s+(fish|discus|stock)\b|\bhealth\s+(of\s+)?(the\s+|your\s+)?(fish|discus)\b/,
  ordering:
    /\b(how\s+(do|can|to)\s+i\s+(order|buy|purchase)|how\s+to\s+(order|buy|purchase)|ordering|place\s+(an\s+)?order|order\s+process|cart)\b/,
  care:
    /\b(care|tips|how\s+to\s+(keep|maintain|look\s+after|raise)|maintenance|water\s+change|water\s+changes|temperature|temp|ph|feeding|how\s+often|tank\s+size|tank\s+mates|setup|set\s+up)\b/,
  price:
    /\b(price|prices|pricing|cost|costs|rate|rates|how\s+much|evlo|evvalavu|evlavu|evalo|evlo\s+aagum|vilai|price\s+enna|enna\s+(price|rate|vilai)|rupees|rs|inr|cheapest|lowest\s+price|least\s+expensive|most\s+expensive|costliest|affordable|budget)\b|₹/,
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
  let pool = filtered ?? cards;
  // "cheapest discus?" / "anything under 1000 rupees?": lowest live prices first.
  const budget = /\b(under|below|less\s+than|within|upto|up\s+to)\s*(₹|rs\.?|inr)?\s*(\d[\d,]*)/.exec(t);
  if (budget || /\b(cheapest|lowest\s+price|least\s+expensive|budget|affordable)\b/.test(t)) {
    const cap = budget ? Number(budget[3]!.replace(/,/g, "")) : Infinity;
    pool = [...pool].filter((c) => c.price <= cap).sort((a, b) => a.price - b.price);
    if (!pool.length) {
      state.pendingOffer = "handoff";
      return {
        reply: "Nothing on our available page matches that right now. Full list: thediscusden.com/available. Want me to ask Shiva about it?",
        intent: "available_filtered_none",
      };
    }
  }
  const list = pool.slice(0, 5);
  const head = kind === "price" ? `${PER_PIECE_LINE} ${ANSWERS.availableIntro}` : ANSWERS.availableIntro;
  state.pendingOffer = "narrow";
  return {
    reply: join(`${head}\n${list.map(cardLine).join("\n")}`, `${VOLUME_DISCOUNT_LINE}\n${ANSWERS.availableOutro}`),
    intent: filtered ? `${kind}_filtered` : `${kind}_list`,
  };
}

/** All cards on the page, including sold-out ones (needed to say "out of stock"). */
async function allStrains(ctx: Ctx): Promise<StrainCard[] | null> {
  try {
    return await ctx.catalog.strains();
  } catch {
    return null;
  }
}

/**
 * One card's availability (C1, Shiva's ruling 3 Oct): in / out of stock only.
 * The site's stock number decides which; the number itself is never written.
 */
function stockLine(c: StrainCard): string {
  const parts = [c.name, c.size].filter(Boolean).join(", ");
  if (!c.available || c.stock === 0) return `• ${c.name}: out of stock right now.`;
  if (c.stock === undefined) return `• ${parts}, ${c.priceText} per piece: see ${ANSWERS.stockPage} for current availability.`;
  return `• ${parts}, ${c.priceText} per piece: in stock right now.`;
}

async function stockAnswer(state: ChatState, raw: string, t: string, ctx: Ctx): Promise<Turn> {
  const cards = await allStrains(ctx);
  if (!cards || !cards.length) {
    state.pendingOffer = "handoff";
    return { reply: ANSWERS.stockFetchFailed, intent: "stock_fallback" };
  }
  const match = matchStrains(raw, cards);
  const chosenWords = new Set(match.cards.flatMap((c) => words(c.name)));
  const unmatchedVocab = strainWordsIn(t)
    .filter((w) => !COLOURS.includes(w))
    .filter((w) => !w.split(" ").every((x) => chosenWords.has(singular(x))));
  if (match.cards.length && !unmatchedVocab.length) {
    for (const c of match.cards) if (!state.interests.includes(c.name)) state.interests.push(c.name);
    state.pendingOffer = "handoff";
    return { reply: join(match.cards.slice(0, 5).map(stockLine).join("\n"), ANSWERS.stockOutro), intent: "stock_strain" };
  }
  // A strain the site doesn't list: no count, ever.
  const vocab = match.cards.length ? unmatchedVocab : strainWordsIn(t).filter((w) => !COLOURS.includes(w));
  if (vocab.length) {
    addFlag(state, `STRAIN NOT LISTED: ${vocab.join(" ")}`.slice(0, 80) as LeadFlag);
    state.pendingOffer = "handoff";
    return { reply: ANSWERS.strainNotListedAsk, intent: "strain_not_listed" };
  }
  const listed = cards.filter((c) => c.available && c.stock !== undefined && c.stock > 0);
  if (!listed.length) {
    state.pendingOffer = "handoff";
    return { reply: ANSWERS.stockFetchFailed, intent: "stock_fallback" };
  }
  state.pendingOffer = "narrow";
  return {
    reply: join(`${ANSWERS.stockIntro}\n${listed.slice(0, 5).map(stockLine).join("\n")}`, ANSWERS.stockListOutro),
    intent: "stock_list",
  };
}

async function ownerAnswer(state: ChatState, ctx: Ctx): Promise<Turn> {
  let owner: string | null = null;
  try {
    owner = (await ctx.catalog.site?.())?.owner ?? null;
  } catch {
    owner = null;
  }
  state.pendingOffer = "handoff";
  return { reply: ownerReply(owner ?? OWNER_FALLBACK), intent: "owner" };
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

const QUARANTINE_HOLD =
  /\b(quarantin\w*|hold|holds|holding|held|keep\s+(my|the)\s+fish|keep\s+them|keeps?\s+(the\s+)?fish|settle\w*|condition\w*\s+(the\s+)?fish)\b/;
const SHIP_WORD =
  /\b(ship|ships|shipped|shipping|send|sends|sent|deliver|delivers|delivered|delivery|courier\w*|dispatch\w*|parcel|post\s+it|anuppu\w*)\b/;

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

// ---------------------------------------------------------------------------
// Intent priority table
//
// Every visitor message is checked against INTENT_RULES top to bottom; the first
// rule whose test() passes (and whose run() returns a Turn) answers. The order is
// the contract:
//   1. safety   - prompt attacks, dead-on-arrival reports, mortality, safe-arrival
//                 guarantees, refund policy, claimed offers, payment details,
//                 discount codes, sick fish, internal figures, "are you a bot",
//                 talk to Shiva. These win whatever else the message says.
//   2. offer    - "yes"/"no" to the offer made in the previous reply.
//   3. faq      - the answer-pack FAQs. Skipped when the message is plainly
//                 off-topic (an off-topic word and no business word), so
//                 "bitcoin price" or "stock market" never reach the price list.
//   4. smalltalk
//   5. offtopic - FAQ 23.
//   6. fallback - FAQ 24 clarifying question (never "I'm not sure").
// ---------------------------------------------------------------------------

type Msg = { state: ChatState; raw: string; t: string; ctx: Ctx; offTopic: boolean };
type RuleTier = "safety" | "offer" | "faq" | "smalltalk" | "offtopic" | "fallback";
type IntentRule = {
  id: string;
  tier: RuleTier;
  /** Answer-pack reference, for docs and tests. */
  faq: string;
  test: (m: Msg) => boolean;
  run: (m: Msg) => Turn | null | Promise<Turn | null>;
};

// ---------------------------------------------------------------------------
// FAQ 26 loss safety net: any message about fish death, loss or a refund.
// Stem / regex families, not sentences. Custom boundaries keep "diet",
// "studied", "indeed", "dieffenbachia", "lossless" and "die-cast" out.
// ---------------------------------------------------------------------------

/** Idioms stripped before matching ("dead set on", "to die for", ...). */
const LOSS_IDIOMS =
  /\bdead\s+(set|easy|serious|seriously|cheap|simple|sure|tired|right|end|ringer|silent|quiet)\b|\bdie[\s-]?hards?\b|\bto\s+die\s+for\b|\bdying\s+(to|for)\s+(get|buy|see|have|try|own|order|know|start|keep|a|an|some|one|this|that)\b|\bdead\s?lines?\b|\bdie[\s-]cast\w*/g;
/** English death words. (?<![\w-]) / (?![\w-]) so "die-cast" etc. never match. */
const LOSS_DEATH =
  /(?<![\w-])(die|dies|died+|dieing|dying|dyin|dead+|ded|death|deaths|deceased|mortality|casualt\w*|survival|survive[sd]?|surviving|survivability|killed|kills?|perish\w*|belly[\s-]up)(?![\w-])|\bpassed\s+away\b|\brip\b(?!\s*off)|\bdid\s*n'?o?t\s+(make\s+it|survive)|\bdidn'?t\s+(make\s+it|survive)|\bdidnt\s+(make\s+it|survive)|\bno\s+longer\s+alive\b|\bnot\s+alive\b/;
const LOSS_FLOATING =
  /\bfloat(ing|s|ed)?\b(?!\s+(plants?|food|pellets?|logs?|decor|ring))/;
const LOSS_FLOAT_CTX = /\b(one|fish|discus|him|her|it|its|it's|they|them|top|surface|upside|belly|not\s+moving|motionless|found|meen)\b/;
const LOSS_LOST =
  /\blost\s+(a|one|two|three|four|\d+|my|both|all|some|many|any|the|few|several|another|of)?\s*(fish|discus|ones?|pairs?|meen|of\s+(them|my|the))\b|\b(have|did|do)\s+(you|u)\s+(ever\s+)?(lost?|lose)\b|\b(lose|loses|losing)\b[^.?!]*\b(fish|discus|many|any|some|meen|them)\b|\bloss(es)?\b(?!\s+of\s+(appetite|colou?r|weight))/;
const LOSS_LOSS_EXCLUDE = /\b(appetite|colou?r|weight|hair)\s+loss\b/;
const LOSS_REFUND =
  /\brefund\w*|\bmoney\s+back\b|\breturn\s+(my\s+|the\s+|our\s+)?(money|amount|payment)\b|\bcompensat\w*|\breimburs\w*|\bcharge\s?-?backs?\b/;
const LOSS_REPLACE =
  /\breplac\w*\b[^.?!]*\b(dead|died|lost|it|them|that\s+one|the\s+one)\b|\b(free\s+)?replacement\s+(fish|discus|for)\b|\bfree\s+replacement\b/;
/** Tanglish stems. Bare "sethu" is also a given name, so it needs fish context. */
const LOSS_TANGLISH_INCIDENT =
  /\bs+e+t+h+u(ruchu|ruch\w*|duchu|dutt?u\w*|pochu|poch\w*|chu|chi\w*|tt?u|ttaa|thu\w*|ra\w*|du\w*|po\w*|irundh\w*|irunth\w*|kidand\w*)\b|\bset+h+u\s+(pochu|poyiduchu|poiduchu|irundh\w*|irunth\w*|kidand\w*|ruchu|duchu)\b|\bsetthu\b|\bseththu\w*|\buyir\s*(poi|poy)\w*|\b(panam|kaasu|kasu|paisa)\s*(thirumba|thiruppi|return|back|wapas|vapas)\w*|\brefund\s+pann\w*/;
const LOSS_SETHU_BARE = /\bsethu\b/;
const LOSS_TANGLISH_QUESTION = /\bsaav\w*|\bsaag\w*|\bsaak\w*|\buyir\w*/;
const LOSS_POIDUCHU = /\b(poiduchu|poyiduchu|pochu|poyidichu)\b/;
const FISH_CTX = /\b(fish|fishes|discus|meen|meenu|ones?|pair|uyir|ellam|rendu|onnu|moonu|box|bag|parcel|cover)\b/;
/** Tamil script (JS \b is ASCII-only, so plain substring families). */
const LOSS_TAMIL_INCIDENT = /செத்து|செத்த|இறந்து|இறந்த|இறந்துவிட்ட|பணம்\s*திரும்ப|காசு\s*திரும்ப/;
const LOSS_TAMIL_ANY = /செத்|இறந்|உயிர்|சாவு|சாக|பணம்\s*திரும்ப|காசு\s*திரும்ப/;

/** True for any message about fish death, loss or a refund (English, Tanglish, Tamil). */
export function isLossMessage(text: string): boolean {
  const t = norm(text).replace(LOSS_IDIOMS, " ");
  if (LOSS_DEATH.test(t) || LOSS_REFUND.test(t) || LOSS_REPLACE.test(t) || LOSS_TAMIL_ANY.test(t)) return true;
  if (LOSS_LOST.test(t) && !LOSS_LOSS_EXCLUDE.test(t) && !/\blost\s+(my\s+|the\s+)?(order|parcel|package|tracking|way|password|money|link|connection|number|receipt)\b/.test(t)) return true;
  if (LOSS_FLOATING.test(t) && LOSS_FLOAT_CTX.test(t)) return true;
  if (LOSS_TANGLISH_INCIDENT.test(t) || LOSS_TANGLISH_QUESTION.test(t)) return true;
  if (LOSS_SETHU_BARE.test(t) && FISH_CTX.test(t)) return true;
  if (LOSS_POIDUCHU.test(t) && FISH_CTX.test(t)) return true;
  return false;
}

/** General / rate questions about The Discus Den (MORTALITY ASKED, not an incident). */
const LOSS_QUESTION_CTX =
  /\b(how\s+many|how\s+often|do\s+(your|you|u|discus|fish|they)|does|will|would|can\s+they|any\s+(deaths?|losses|casualt\w*)|any\s+(fish|discus)\s+die|did\s+any|rate|rates|usually|often|normally|typically|easily|policy|do\s+you\s+give|is\s+there|what\s+happens|what\s+if|in\s+case|if\s+(a|the|any|it|they)\b|percentage|percent|survival|mortality|lately|in\s+your\s+tanks?|guarantee|aagum|aaguma|varuma|saagudh\w*|saaguma|with\s+you|have\s+(many|any|lots)|were\s+any|any\s+(fish|discus|of\s+them)|your|ur|yours|keep\s+dying|i\s+heard|heard\s+that|rumou?rs?|true|policy|lots\s+of|is\s+it\s+true|are\s+(your|the|discus)|ever|evlo|evvalavu|evalo|ethana|ethanai|indha\s+maasam|last\s+(week|month|year|batch)|this\s+(month|year|week))\b|எத்தனை|எவ்வளவு/;
/** Strong personal markers: these outweigh question wording ("my fish died, do you refund?"). */
const LOSS_PERSONAL =
  /\b(my|mine|our|i\s+got|i\s+bought|i\s+received|from\s+you|arrived|came\s+dead|reached\s+dead|in\s+the\s+(bag|box|parcel|packet|cover)|box\s+la|opened|unbox\w*|video|promised|said|process|apply|approved|venum|kudunga|pannunga|me|i\s+(lost|had)|last\s+night|this\s+morning|just\s+now)\b|^lost\s+(a|one|my|two|\d+)\b/;
/** Personal incident wording ("my fish died", "arrived dead", "sethu irundhuchu", "money back"). */
const LOSS_INCIDENT_CTX =
  /\b(my|mine|our|i\s+got|i\s+bought|i\s+received|from\s+you|arrived|came\s+dead|reached\s+dead|in\s+the\s+(bag|box|parcel|packet|cover)|box\s+la|opened|unbox\w*|found|this\s+morning|last\s+night|today|yesterday|just\s+now|video|promised|said|process|apply|approved|venum|kudunga|pannunga|me|pls|please|help|what\s+(do|now|should))\b/;

/** Judge only the clause(s) that carry the loss words ("fish died, also is there a code..."). */
function isLossIncident(text: string): boolean {
  const clauses = norm(text).split(/[,.;!?]+|\balso\b|\bbtw\b/).map((c) => c.trim()).filter(Boolean);
  const lossy = clauses.filter((c) => isLossMessage(c));
  return (lossy.length ? lossy : [norm(text)]).some(isLossIncidentClause);
}

function isLossIncidentClause(text: string): boolean {
  const t = norm(text).replace(LOSS_IDIOMS, " ");
  if (LOSS_QUESTION_CTX.test(t) && !LOSS_PERSONAL.test(t)) return false;
  if (LOSS_TAMIL_INCIDENT.test(t) || LOSS_TANGLISH_INCIDENT.test(t)) return true;
  if ((LOSS_SETHU_BARE.test(t) || LOSS_POIDUCHU.test(t)) && FISH_CTX.test(t)) return true;
  const pastOrNow =
    /(?<![\w-])(died+|dead+|ded|dying|dyin|dieing|deceased|killed|casualty)(?![\w-])|\bpassed\s+away\b|\brip\b|\bdid\s*n'?o?t\s+(make\s+it|survive)|\bdidn'?t\s+(make\s+it|survive)|\bdidnt\s+(make\s+it|survive)|\bbelly[\s-]up\b|\bfloat\w*|\blost\s+(a|one|two|\d+|my|both|the|another)\b|\bnot\s+alive\b/;
  const claim = LOSS_REFUND.test(t) || LOSS_REPLACE.test(t);
  if (LOSS_QUESTION_CTX.test(t) && !LOSS_PERSONAL.test(t)) return false;
  if (pastOrNow.test(t)) return true;
  return claim && LOSS_INCIDENT_CTX.test(t);
}

function lossSafetyNet(state: ChatState, raw: string): Turn {
  addFlag(state, isLossIncident(raw) ? "DOA CLAIM" : "MORTALITY ASKED");
  if (state.completed) {
    state.pendingOffer = null;
    return { reply: join(stripOffer(ANSWERS.lossSafetyNet), ANSWERS.handoffAlreadyDone), intent: "loss_safety_net" };
  }
  // FAQ 26: the reply ends with "Shall I pass your details to him?" and the
  // handoff starts right away; "yes" -> name question, "no" -> cancel.
  state.handoff.active = true;
  state.handoff.phoneTries = 0;
  state.handoff.declined = [];
  state.handoff.awaitingConsent = true;
  state.pendingOffer = null;
  prefillFromMessage(state, raw, norm(raw));
  state.handoff.step = nextStep(state) ?? "name";
  return { reply: ANSWERS.lossSafetyNet, intent: "loss_safety_net" };
}

const DEATH_REPORT = /\b(died|dead|doa|passed\s+away|not\s+alive|didn'?t\s+survive|did\s+not\s+survive|no\s+longer\s+alive)\b/;
const ARRIVAL_CONTEXT =
  /\b(arriv\w*|in\s+the\s+(bag|box|packet|pack|parcel|cover|carton)|on\s+arrival|doa|when\s+(it|they|i)\s+(came|reached|got|opened|received)|after\s+(delivery|unboxing|opening)|unbox\w*|received|delivered|reached|my\s+(fish|discus|order|parcel|pair|ones?)|our\s+(fish|order)|i\s+(have|took|recorded|shot)\s+(the\s+|a\s+)?video|video)\b/;
const HYPOTHETICAL = /\b(what\s+(happens\s+)?if|in\s+case|suppose|if\s+(a|the|any|my)\b|would\s+you|do\s+you\s+(refund|replace))\b/;
const MORTALITY_TIME =
  /\b(last|this|past|previous)\s+(week|month|year|batch|shipment|lot|time)|\b(recently|yesterday|today|so\s+far|lately|any|did\s+any|have\s+any|were\s+any|in\s+your\s+tanks?|with\s+you)\b/;
const GUARANTEE_WORD = /\b(guarantee\w*|surely|for\s+sure|definitely|safe|safely|alive|survive\w*|in\s+good\s+condition|without\s+(dying|loss))\b/;
const TRAVEL_WORD = /\b(arriv\w*|reach\w*|deliver\w*|ship\w*|transit|journey|travel\w*|courier|send|sent|come|trip|train)\b/;
const EQUIPMENT =
  /\b(sell|have|stock|get|buy|provide)\b[^?.]*\b(filters?|heaters?|lights?|lighting|equipment|accessories|substrate|gravel|decorations?|decor|driftwood|co2|air\s+pumps?|pumps?|(fish\s+)?tanks\s+(or|and)|aquariums\s+(or|and)|glass\s+tanks?)\b/;
const QR_PAYMENT = /\bqr(\s*code)?\b/;
const CODE_QUALIFIER =
  /\b(work|works|working|worked|valid|validity|apply|applied|applies|use|used|usable|accept\w*|expired?|still|aaguma|aagum|aagudha|aagutha|velai|velaiseyyuma|irukka|irukku|iruka|enna|discount|coupon|promo|first[\s-]?time|offer|cart|checkout)\b/;
const PROGRAMMING = /\b(python|javascript|typescript|java|html|css|sql|program\w*|coding|script|write|function|bug|compile|source)\b/;
const BUSINESS_WORD =
  /\b(discus|fish|fishes|aquarium|tank|strains?|pellets?|bloodworms?|food|order|orders|cart|delivery|deliver|shipping|ship|pickup|pay|payment|gpay|upi|buy|shiva|tdd|den|quarantine|refund|discount|coupon|promo)\b/;

/** FAQ 10: a visitor reporting fish that arrived dead (or claiming the refund for it). */
function isDoaReport(t: string): boolean {
  if (HYPOTHETICAL.test(t) && !/\b(my|our)\s+(fish|discus|order|parcel)\b|\bi\s+have\b/.test(t)) return false;
  if (DEATH_REPORT.test(t) && ARRIVAL_CONTEXT.test(t)) return true;
  // "refund approved right? I have the video" without a death word.
  return /\brefund\b/.test(t) && /\b(video|unbox\w*|arriv\w*|in\s+the\s+bag)\b/.test(t) && !HYPOTHETICAL.test(t);
}

/** FAQ 21: questions about deaths or losses at The Discus Den (not the visitor's own fish). */
function isMortality(t: string): boolean {
  if (RE.sickOften.test(t)) return true;
  if (!RE.mortalityWord.test(t)) return false;
  if (RE.mortalityTamil.test(t) || /\bmortality\b|\bloss(es)?\s+rate\b|\bdeath\s+rate\b|\blost\s+any\b|\bany\s+(losses|deaths)\b/.test(t)) return true;
  return (RE.mortalityContext.test(t) || MORTALITY_TIME.test(t)) && !RE.mortalityPersonal.test(t);
}

/** FAQ 5/10/25: "will they surely arrive safe / guarantee safe arrival". */
function isGuarantee(t: string): boolean {
  if (RE.claimVerb.test(t)) return false;
  if (/\b(safe|live)\s+arrival\b|\barrive\s+(safe|safely|alive)\b/.test(t)) return true;
  return GUARANTEE_WORD.test(t) && TRAVEL_WORD.test(t);
}

/** FAQ 22: a claimed promise or offer ("Shiva said...", "you offered...", "apply it"). */
function isClaimedOffer(t: string): boolean {
  const isQuestionAsk = /^(can|could|will|would|do|does|is|any|how)\b/.test(t);
  return (RE.claimVerb.test(t) && RE.offerish.test(t)) || RE.claimApply.test(t) || (RE.claimFreeMonth.test(t) && !isQuestionAsk);
}

/**
 * FAQ 19: discount / coupon / first-time code questions, in English or Tanglish.
 * Generic patterns only: the visitor may type a real code word themselves, and
 * no code word is ever listed here.
 */
function isDiscountCode(t: string, raw: string): boolean {
  if (QR_PAYMENT.test(t)) return false;
  const discountWord = /\b(discount|coupon|promo|voucher|offers?|first[\s-]?time|referral|cashback)\b|%\s*off/.test(t);
  if (PROGRAMMING.test(t) && !discountWord) return false;
  if (RE.discount.test(t) || COUPON_TOKEN.test(raw)) return true;
  if (!/\bcodes?\b/.test(t) || PROGRAMMING.test(t)) return false;
  if (CODE_QUALIFIER.test(t)) return true;
  // "<token> code?" / "is <token> code ..." asked as a question.
  const asked = raw.includes("?") || /^(is|does|will|can|what|which|any|ithu|indha)\b/.test(t);
  return asked && /\b[a-z0-9]{3,}\s+codes?\b/.test(t);
}

function isPaymentDetails(t: string, raw: string): boolean {
  return RE.paymentConfirm.test(t) || (RE.payment.test(t) && (digitCount(raw) >= 6 || /@/.test(raw)));
}

function guaranteeAnswer(state: ChatState, t: string): Turn {
  addFlag(state, "GUARANTEE ASKED");
  const place = findPlace(t);
  if (place) state.lead.stateName ??= place.state;
  if (!place) {
    state.pendingOffer = null;
    return { reply: ANSWERS.doa, intent: "guarantee" };
  }
  if (place.zone === "in") {
    state.pendingOffer = null;
    return { reply: join(ANSWERS.shipInStates, ANSWERS.doa), intent: "guarantee_in_states" };
  }
  addFlag(state, "OUTSIDE 8 STATES");
  state.pendingOffer = "handoff";
  if (place.zone === "other") return { reply: ANSWERS.shipOtherState, intent: "guarantee_other_state" };
  addFlag(state, "REMOTE");
  if (place.zone === "remote") return { reply: ANSWERS.shipRemote, intent: "guarantee_remote" };
  return { reply: ANSWERS.shipAbroad, intent: "guarantee_abroad" };
}

const sizeAskRe = /(\d+(?:\.\d+)?)\s*(?:"|inch|inches)|\b(small|big|large|adult|juvenile)\s+(ones?|fish|discus|size)\b/;
const hasColour = (t: string) => COLOURS.some((c) => new RegExp(`\\b${c}\\b`).test(t));

export const INTENT_RULES: readonly IntentRule[] = [
  // ---- 1. safety ----
  {
    // FAQ 26 runs before every other answer, prompt attacks included (the reply is canned and safe).
    id: "loss_safety_net", tier: "safety", faq: "FAQ 26",
    test: (m) => isLossMessage(m.raw),
    run: ({ state, raw }) => lossSafetyNet(state, raw),
  },
  {
    id: "prompt_attack", tier: "safety", faq: "Rules: prompt attacks",
    test: (m) => RE.promptAttack.test(m.t),
    run: ({ state }) => { state.pendingOffer = null; return { reply: ANSWERS.promptAttack, intent: "prompt_attack" }; },
  },
  {
    id: "doa_report", tier: "safety", faq: "FAQ 10 (report)",
    test: (m) => isDoaReport(m.t),
    run: ({ state, raw }) => { addFlag(state, "DOA CLAIM"); return startHandoff(state, raw, ANSWERS.doa); },
  },
  {
    id: "mortality", tier: "safety", faq: "FAQ 21",
    test: (m) => isMortality(m.t),
    run: ({ state }) => { addFlag(state, "MORTALITY ASKED"); state.pendingOffer = "handoff"; return { reply: ANSWERS.mortality, intent: "mortality" }; },
  },
  {
    id: "guarantee", tier: "safety", faq: "FAQ 5 / 10 / 25",
    test: (m) => isGuarantee(m.t),
    run: ({ state, t }) => guaranteeAnswer(state, t),
  },
  {
    id: "doa_policy", tier: "safety", faq: "FAQ 10",
    test: (m) => RE.doaQuestion.test(m.t) || (RE.refundSure.test(m.t) && !RE.claimVerb.test(m.t)),
    run: ({ state, t }) => {
      addFlag(state, "GUARANTEE ASKED");
      state.pendingOffer = RE.refundSure.test(t) ? "handoff" : null;
      return { reply: ANSWERS.doa, intent: "doa_policy" };
    },
  },
  {
    id: "claimed_offer", tier: "safety", faq: "FAQ 22",
    test: (m) => isClaimedOffer(m.t),
    run: ({ state, t }) => {
      addFlag(state, "CLAIMED OFFER");
      if (/\b(hold|holding|month)\b/.test(t)) addFlag(state, "LONG HOLD");
      if (/\brefund\b/.test(t)) addFlag(state, "GUARANTEE ASKED");
      if (/\b(off|free|discount|offer|cheaper|less|code|coupon|bonus|gift|waive\w*)\b|%|₹|\brs\.?\s*\d/.test(t)) addFlag(state, "DISCOUNT ASKED");
      state.pendingOffer = "handoff";
      return { reply: ANSWERS.claimedOffer, intent: "claimed_offer" };
    },
  },
  {
    id: "payment_details", tier: "safety", faq: "Rule 5a",
    test: (m) => isPaymentDetails(m.t, m.raw),
    run: ({ state }) => { addFlag(state, "PAYMENT ASKED"); state.pendingOffer = null; return { reply: ANSWERS.paymentDetails, intent: "payment_details" }; },
  },
  {
    id: "payment_qr", tier: "safety", faq: "FAQ 7",
    test: (m) => QR_PAYMENT.test(m.t),
    run: ({ state }) => { state.pendingOffer = null; return { reply: ANSWERS.howToPay, intent: "how_to_pay" }; },
  },
  {
    id: "discount", tier: "safety", faq: "FAQ 19",
    test: (m) => isDiscountCode(m.t, m.raw),
    run: ({ state }) => {
      addFlag(state, "DISCOUNT ASKED");
      state.pendingOffer = "handoff";
      return { reply: `${ANSWERS.discount}\n\n${VOLUME_DISCOUNT_LINE}`, intent: "discount" };
    },
  },
  {
    id: "doa_refund", tier: "safety", faq: "FAQ 10 (report)",
    test: (m) => RE.doaReport.test(m.t),
    run: ({ state, raw }) => { addFlag(state, "DOA CLAIM"); return startHandoff(state, raw, ANSWERS.doa); },
  },
  {
    id: "sick_fish", tier: "safety", faq: "FAQ 18",
    test: (m) => RE.sick.test(m.t),
    run: ({ state }) => { addFlag(state, "SICK FISH"); state.pendingOffer = "handoff"; return { reply: ANSWERS.sickFish, intent: "sick_fish" }; },
  },
  {
    id: "internal_figures", tier: "safety", faq: "Rules 1-3",
    test: (m) => RE.internal.test(m.t),
    run: ({ state }) => { state.pendingOffer = "narrow"; return { reply: ANSWERS.noInternalFigures, intent: "internal_figures" }; },
  },
  {
    // LB-2 (Shiva, 3 Oct): availability only (in / out of stock), never a quantity.
    id: "stock_count", tier: "safety", faq: "C1: availability only",
    test: (m) => RE.stock.test(m.t),
    run: ({ state, raw, t, ctx }) => stockAnswer(state, raw, t, ctx),
  },
  {
    // LB-1: the owner's name as printed on the site. Never a phone/GPay number.
    id: "owner", tier: "safety", faq: "B12: owner name from site",
    test: (m) => RE.owner.test(m.t),
    run: ({ state, ctx }) => ownerAnswer(state, ctx),
  },
  {
    id: "are_you_human", tier: "safety", faq: "Rules: are you a person",
    test: (m) => RE.human.test(m.t),
    run: ({ state }) => { state.pendingOffer = null; return { reply: ANSWERS.areYouHuman, intent: "are_you_human" }; },
  },
  {
    id: "talk_to_shiva", tier: "safety", faq: "Handoff",
    test: (m) => RE.talkToShiva.test(m.t),
    run: ({ state, raw }) => startHandoff(state, raw),
  },

  // ---- 2. replies to the previous offer ----
  {
    id: "offer_accept", tier: "offer", faq: "Handoff",
    test: ({ state, t }) => state.pendingOffer === "handoff" && RE.affirm.test(t) && t.split(" ").length <= 5,
    run: ({ state, raw }) => startHandoff(state, raw),
  },
  {
    id: "offer_decline", tier: "offer", faq: "Handoff",
    test: ({ state, t }) => Boolean(state.pendingOffer) && RE.negate.test(t) && t.split(" ").length <= 5,
    run: ({ state }) => { state.pendingOffer = null; return { reply: ANSWERS.handoffDeclined, intent: "offer_declined" }; },
  },
  {
    id: "narrow_ask", tier: "offer", faq: "Quick tap",
    test: ({ state, t }) => state.pendingOffer === "narrow" && RE.affirm.test(t) && !RE.available.test(t) && !COLOURS.some((c) => t.includes(c)),
    run: ({ state }) => { state.pendingOffer = "narrow"; return { reply: "Sure. Which size or colour would you like?", intent: "narrow_ask" }; },
  },

  // ---- 3. FAQs ----
  {
    // Equipment we don't sell (filters, heaters, tanks...): FAQ 23 redirect.
    id: "equipment", tier: "faq", faq: "FAQ 23",
    test: (m) => EQUIPMENT.test(m.t) && !/\b(discus|fish|food|pellets?)\b/.test(m.t.replace(/\bfish\s+tanks?\b/, "")),
    run: ({ state }) => { state.pendingOffer = null; return { reply: ANSWERS.offTopic, intent: "off_topic" }; },
  },
  {
    id: "reseller", tier: "faq", faq: "FAQ 17",
    test: (m) => RE.reseller.test(m.t),
    run: ({ state }) => { state.pendingOffer = "handoff"; return { reply: ANSWERS.reseller, intent: "reseller" }; },
  },
  {
    // LB-3: quarantine / hold / keep-the-fish + shipping in one message ->
    // "Yes." + quarantine (FAQ 13) + hold rule (FAQ 14) + delivery (FAQ 5/25),
    // ahead of the plain holding and delivery-states answers.
    id: "quarantine_ship", tier: "faq", faq: "LB-3: FAQ 13 + 14 + 5",
    test: (m) => QUARANTINE_HOLD.test(m.t) && SHIP_WORD.test(m.t),
    run: ({ state, t }) => {
      const delivery = shippingAnswer(state, t);
      let hold: string = ANSWERS.holding;
      if (RE.holdingBeyond.test(t)) {
        addFlag(state, "LONG HOLD");
        hold = `${ANSWERS.holding} ${ANSWERS.holdingBeyond}`;
        state.pendingOffer = "handoff";
      }
      return {
        reply: join(`${ANSWERS.quarantineShipYes} ${ANSWERS.quarantine} ${hold}`, delivery.reply),
        intent: "quarantine_ship",
      };
    },
  },
  {
    id: "holding", tier: "faq", faq: "FAQ 14",
    test: (m) => RE.holding.test(m.t) && !RE.ship.test(m.t),
    run: ({ state, t }) => {
      state.tags.history ??= "first-timer";
      if (RE.holdingBeyond.test(t)) {
        addFlag(state, "LONG HOLD");
        state.pendingOffer = "handoff";
        return { reply: `${ANSWERS.holding} ${ANSWERS.holdingBeyond}`, intent: "holding_beyond" };
      }
      state.pendingOffer = null;
      return { reply: ANSWERS.holding, intent: "holding" };
    },
  },
  { id: "goat_heart", tier: "faq", faq: "FAQ 16", test: (m) => RE.goatHeart.test(m.t), run: ({ state, ctx }) => foodAnswer(state, ctx, true) },
  { id: "food", tier: "faq", faq: "FAQ 15", test: (m) => RE.food.test(m.t), run: ({ state, ctx }) => foodAnswer(state, ctx, false) },
  {
    id: "pair_or_single", tier: "faq", faq: "FAQ 4",
    test: (m) => RE.pairSingle.test(m.t),
    run: ({ state }) => { state.pendingOffer = "handoff"; return { reply: ANSWERS.pairOrSingle, intent: "pair_or_single" }; },
  },
  {
    id: "per_piece", tier: "faq", faq: "FAQ 2 (per piece)",
    test: (m) => RE.perPiece.test(m.t) && !matchAny(m.raw),
    run: ({ state }) => { state.pendingOffer = null; return { reply: `${PER_PIECE_LINE} ${VOLUME_DISCOUNT_LINE}`, intent: "per_piece" }; },
  },
  {
    id: "beginner", tier: "faq", faq: "FAQ 3",
    test: (m) => RE.beginner.test(m.t) && /\b(strain|which|what|suggest|recommend|good|best|start|fish|discus)\b/.test(m.t),
    run: ({ state, ctx }) => beginnerAnswer(state, ctx),
  },
  {
    id: "ship_cost", tier: "faq", faq: "FAQ 8",
    test: (m) => RE.shipCost.test(m.t),
    run: ({ state }) => { state.pendingOffer = null; return { reply: ANSWERS.shippingCost, intent: "ship_cost" }; },
  },
  {
    id: "pickup", tier: "faq", faq: "FAQ 12",
    test: (m) => RE.pickup.test(m.t),
    run: ({ state }) => { state.lead.delivery ??= "Chennai pickup"; state.pendingOffer = "handoff"; return { reply: ANSWERS.pickup, intent: "pickup" }; },
  },
  {
    id: "ship_how", tier: "faq", faq: "FAQ 9",
    test: (m) => RE.shipHow.test(m.t) && !findPlace(m.t),
    run: ({ state }) => { state.pendingOffer = null; return { reply: ANSWERS.shippingHow, intent: "ship_how" }; },
  },
  { id: "ship", tier: "faq", faq: "FAQ 5 / 25", test: (m) => RE.ship.test(m.t), run: ({ state, t }) => shippingAnswer(state, t) },
  {
    id: "visit", tier: "faq", faq: "FAQ 11",
    test: (m) => RE.visit.test(m.t),
    run: ({ state }) => { state.pendingOffer = "handoff"; return { reply: ANSWERS.visit, intent: "visit" }; },
  },
  {
    id: "quarantine", tier: "faq", faq: "FAQ 13",
    test: (m) => RE.quarantine.test(m.t),
    run: ({ state }) => { state.pendingOffer = null; return { reply: ANSWERS.quarantine, intent: "quarantine" }; },
  },
  {
    id: "ordering", tier: "faq", faq: "FAQ 6",
    test: (m) => RE.ordering.test(m.t),
    run: ({ state }) => { state.pendingOffer = null; return { reply: ANSWERS.ordering, intent: "ordering" }; },
  },
  {
    id: "how_to_pay", tier: "faq", faq: "FAQ 7",
    test: (m) => RE.payment.test(m.t),
    run: ({ state }) => { state.pendingOffer = null; return { reply: ANSWERS.howToPay, intent: "how_to_pay" }; },
  },
  {
    id: "price", tier: "faq", faq: "FAQ 2",
    test: (m) => RE.price.test(m.t),
    run: async ({ state, raw, t, ctx }) => {
      if (RE.perPiece.test(t) && !matchAny(raw)) {
        state.pendingOffer = null;
        return { reply: `${PER_PIECE_LINE} ${VOLUME_DISCOUNT_LINE}`, intent: "per_piece" };
      }
      return priceOrAvailability(state, raw, t, ctx, "price");
    },
  },
  { id: "available", tier: "faq", faq: "FAQ 1", test: (m) => RE.available.test(m.t), run: ({ state, raw, t, ctx }) => priceOrAvailability(state, raw, t, ctx, "available") },
  {
    id: "care_tips", tier: "faq", faq: "Quick tap: care tips",
    test: (m) => RE.care.test(m.t),
    run: ({ state }) => { state.pendingOffer = "handoff"; return { reply: ANSWERS.careTips, intent: "care_tips" }; },
  },
  {
    // A strain, colour or size named on its own ("yellow diamonds?", "red ones", "any 5 inch?").
    id: "strain_named", tier: "faq", faq: "FAQ 2 / 20",
    test: (m) => strainWordsIn(m.t).length > 0 || sizeAskRe.test(m.t) || hasColour(m.t),
    run: ({ state, raw, t, ctx }) =>
      priceOrAvailability(state, raw, t, ctx, sizeAskRe.test(t) || COLOURS.some((c) => t.includes(c)) ? "available" : "strain"),
  },
  {
    // Contact details typed out of the blue: start the handoff with them prefilled.
    id: "contact_typed", tier: "faq", faq: "Handoff",
    test: (m) => extractIndianMobile(m.raw) !== null,
    run: ({ state, raw }) => startHandoff(state, raw),
  },
  {
    id: "name_given", tier: "faq", faq: "Handoff",
    test: (m) => /^(my\s+name\s+is|i\s+am|i'm|this\s+is)\s+/i.test(m.raw) && parseName(m.raw) !== null && !findPlace(m.t),
    run: ({ state, raw }) => {
      state.lead.name = parseName(raw)!;
      state.pendingOffer = null;
      return { reply: `Thanks, ${state.lead.name}. How can I help?`, intent: "name_given" };
    },
  },
  {
    // Self-location ("I'm in Delhi", "I live in Pune") answers "do you ship to my city?".
    // A city name on its own (or inside an unrelated question) does not.
    id: "self_location", tier: "faq", faq: "FAQ 5 / 25",
    test: (m) => findPlace(m.t) !== null && /\b(i'?m|i\s+am|we\s+are|i\s+live|we\s+live|living|staying|based|from)\b|\b(la|le)\s+irukk\w*/.test(m.t),
    run: ({ state, t }) => shippingAnswer(state, t),
  },

  // ---- 4. small talk ----
  { id: "welcome", tier: "smalltalk", faq: "Welcome", test: (m) => RE.greeting.test(m.t), run: ({ state }) => { state.pendingOffer = null; return { reply: ANSWERS.welcome, intent: "welcome" }; } },
  { id: "thanks", tier: "smalltalk", faq: "Small talk", test: (m) => RE.thanks.test(m.t), run: ({ state }) => { state.pendingOffer = null; return { reply: ANSWERS.thanks, intent: "thanks" }; } },
  { id: "bye", tier: "smalltalk", faq: "Small talk", test: (m) => RE.bye.test(m.t), run: ({ state }) => { state.pendingOffer = null; return { reply: ANSWERS.bye, intent: "bye" }; } },
  {
    id: "ack", tier: "smalltalk", faq: "Small talk",
    test: (m) => RE.affirm.test(m.t) || RE.negate.test(m.t),
    run: ({ state }) => { state.pendingOffer = null; return { reply: ANSWERS.handoffDeclined, intent: "ack" }; },
  },

  // ---- 5. off-topic (FAQ 23) ----
  {
    id: "off_topic", tier: "offtopic", faq: "FAQ 23",
    test: (m) => m.offTopic,
    run: ({ state }) => { state.pendingOffer = null; return { reply: ANSWERS.offTopic, intent: "off_topic" }; },
  },

  // ---- 6. fallback: FAQ 24 clarifying question ----
  {
    id: "unclear", tier: "fallback", faq: "FAQ 24",
    test: () => true,
    run: ({ state }) => { state.pendingOffer = null; return { reply: ANSWERS.unclear, intent: "unclear" }; },
  },
];

/** Rule ids in priority order (exported for docs and tests). */
export const INTENT_PRIORITY: readonly string[] = INTENT_RULES.map((r) => r.id);

/** Plainly off-topic: an off-topic word and nothing about fish, orders or the den. */
function isOffTopic(t: string): boolean {
  return (RE.offTopic.test(t) || /^codes?\W*$/.test(t)) && !RE.fishCore.test(t) && !BUSINESS_WORD.test(t.replace(/^codes?\W*$/, ""));
}

const NO_CATALOG: CatalogLoader = { strains: async () => null, foods: async () => ({ frozen: null, pellets: null }) };

/** The safety rule (if any) that a message triggers; used to interrupt a handoff. */
export function safetyIntent(raw: string): string | null {
  const t = norm(raw);
  const m: Msg = { state: newChatState(), raw, t, ctx: { catalog: NO_CATALOG }, offTopic: false };
  const rule = INTENT_RULES.find((r) => r.tier === "safety" && r.id !== "talk_to_shiva" && r.test(m));
  return rule ? rule.id : null;
}

/** Normal (non-handoff) routing: first matching rule in INTENT_RULES wins. */
async function routeIntent(state: ChatState, raw: string, t: string, ctx: Ctx): Promise<Turn> {
  const m: Msg = { state, raw, t, ctx, offTopic: isOffTopic(t) };
  for (const rule of INTENT_RULES) {
    if (rule.tier === "faq" && m.offTopic) continue;
    if (!rule.test(m)) continue;
    const turn = await rule.run(m);
    if (turn) return turn;
  }
  state.pendingOffer = null;
  return { reply: ANSWERS.unclear, intent: "unclear" };
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

  // Safety questions (mortality, safe arrival, DOA, claimed offers...) are always
  // answered, even if they also parse as a field ("...last week" at the timeline step).
  const safety = safetyIntent(raw);
  const interrupt = safety !== null && !(step === "phone" && safety === "payment_details");
  if (state.handoff.awaitingConsent) {
    state.handoff.awaitingConsent = false;
    const short = t.split(" ").length <= 5;
    if (!interrupt && short && RE.negate.test(t)) {
      state.handoff.active = false;
      state.handoff.step = undefined;
      return { reply: ANSWERS.handoffDeclined, intent: "handoff_cancelled" };
    }
    if (!interrupt && short && RE.affirm.test(t)) return { reply: askFor(step, state), intent: "handoff" };
  }
  const answered = !interrupt && looksLikeAnswer(step, raw, t);

  // A question instead of an answer: answer it, then re-ask the same field.
  // Prompt attacks and other safety rules always take this path.
  if (interrupt || (!answered && !RE.declineField.test(t))) {
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
      return { reply: join(stripOffer(r.reply.replace(ANSWERS.handoffAlreadyDone, "").trim()), askFor(step, state)), intent: `${r.intent}+handoff` };
    }
    if (r.intent === "prompt_attack") {
      return { reply: join(r.reply, askFor(step, state)), intent: "prompt_attack+handoff" };
    }
    // An unrecognised question at a free-text step: don't store it as the answer; ask again.
    if (raw.includes("?") && (step === "pairSingle" || step === "delivery" || step === "timeline")) {
      return { reply: join(ANSWERS.unclear, askFor(step, state)), intent: "unclear+handoff" };
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
