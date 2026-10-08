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

import { createHash } from "node:crypto";
import {
  ANSWERS,
  deliveryTimingFor,
  OWNER_FALLBACK,
  outOfAreaReply,
  ownerReply,
  PER_PIECE_LINE,
  SITE_STEPS,
  VOLUME_DISCOUNT_LINE,
  type LeadFlag,
} from "./answers.ts";
import type { CatalogLoader, FoodItem, StrainCard } from "./catalog.ts";
import { findPlace, findPlaceFuzzy, type Place } from "./places.ts";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * LB-11 (Shiva, 3 Oct): "pair or single" is gone. "lookingFor" (Discus fish or
 * Discus frozen foods) is asked right after the name, so the LB-7 alert, which
 * fires on the turn the number arrives, already carries it.
 */
export type HandoffStep = "name" | "lookingFor" | "phone" | "city" | "delivery" | "timeline";
const HANDOFF_ORDER: HandoffStep[] = ["name", "lookingFor", "phone", "city", "delivery", "timeline"];
export const LOOKING_FISH = "Discus fish";
export const LOOKING_FOOD = "Discus frozen foods";
export const LOOKING_BOTH = "Discus fish and frozen foods";

export type LeadData = {
  name?: string;
  phone?: string;
  city?: string;
  stateName?: string;
  inShipStates?: boolean | null;
  /** LB-11: "Discus fish" / "Discus frozen foods" / both / free text. */
  lookingFor?: string;
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
  pendingOffer: "handoff" | "narrow" | "lookingFor" | null;
  handoff: {
    active: boolean;
    step?: HandoffStep;
    phoneTries: number;
    nameTries: number;
    declined: HandoffStep[];
    /** Set after the FAQ 26 reply ("Shall I pass your details to him?"): next message may be yes/no. */
    awaitingConsent?: boolean;
    /** LB-11: steps that make no sense for this handoff (e.g. fish-or-food on a DOA claim). */
    skip?: HandoffStep[];
    /** LB-11: unclear fish-or-food answers re-asked once. */
    lookingTries?: number;
  };
  lead: LeadData;
  tags: LeadTags;
  flags: string[];
  /** Live strain names the visitor asked about (for the alert's Interest line). */
  interests: string[];
  completed: boolean;
  /** LB-6: how many times the visitor pushed to reach a human (steered to the site). */
  humanPushes?: number;
  /**
   * LB-11: what the last handoff offer was about, so "yes" sets up the right slots:
   * "claim" (DOA / sick / mortality: no fish-or-food question), "fish" (already about fish).
   */
  handoffKind?: "claim" | "fish";
  /** LB-13: fish-or-food answer given after a pleasantry (prefills a later handoff; not a lead by itself). */
  lookingForHint?: string;
  /** LB-13: the fish-or-food question was already asked after a pleasantry this session. */
  askedLookingFor?: boolean;
  /**
   * LB-19: name + WhatsApp asks in this chat (max 2). `pending` = the last bot reply
   * asked; `awaitingName` = a number came without a name.
   */
  contactAsk?: { count: number; lastTurn: number; pending: boolean; declined: boolean; awaitingName?: boolean };
  /**
   * LB-24 (Shiva, 8 Oct 2:44 PM, privacy): SERVER-SIDE ONLY, never read by the engine and never
   * shown: one-way hashes of valid numbers typed in earlier chats on this browser session.
   * lead-alert uses it only to tag Shiva's email [Lead · returning] when the number typed IN
   * THIS CHAT matches. (Replaces LB-19's `prior` name / phone / city, which shaped replies.)
   */
  onFile?: string[];
  /** LB-19: numbers typed this chat that failed the 10-digit mobile check. */
  badNumbers?: number;
  /** LB-19: LB-15 polite replies given this chat (rotation index). */
  pushFirms?: number;
  /** LB-22/25: next rotation index per reply kind (no reply repeats word for word in a chat). */
  askRot?: { both?: number; phone?: number; name?: number; later?: number; passed?: number; privacy?: number; decline?: number; greet?: number };
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
  /** LB-19: a valid Indian mobile was captured on this turn (saved; the email still waits for chat end). */
  phoneCapturedNow: boolean;
  /** LB-19: this reply is the closing message after details were collected (the chat ends). */
  closedNow: boolean;
};

/** LB-24: one-way key of a valid number (server-side returning check; the number itself is never kept). */
export function phoneKey(phone: string): string {
  return createHash("sha256").update(`tdd-chat-phone:${phone.replace(/\D/g, "").slice(-10)}`).digest("hex").slice(0, 32);
}

/**
 * LB-24 (privacy): a fresh engine state for a NEW chat on an existing browser session. A shared
 * device means the next chat may be a different person, so NO name / number / city carries over:
 * the bot only uses details typed in this chat. Only one-way keys of earlier valid numbers are kept
 * (`onFile`, server-side, for the [Lead · returning] tag in Shiva's email).
 */
export function newChatFrom(prev: ChatState | null | undefined): ChatState {
  const fresh = newChatState();
  if (!prev || prev.v !== 1) return fresh;
  const legacy = (prev as { prior?: { phone?: string } }).prior?.phone; // LB-19 sessions saved before LB-24
  const keys = new Set(prev.onFile ?? []);
  for (const p of [prev.lead?.phone, legacy]) if (p) keys.add(phoneKey(p));
  if (keys.size) fresh.onFile = [...keys].slice(-10);
  if (prev.tags?.history) fresh.tags.history = prev.tags.history;
  return fresh;
}

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
    /\b(mortality|death\s+rate|how\s+many\s+died|losses|supplier|suppliers|breeders?(?!\s*(pairs?|size|stock|discus|fish))|where\s+do\s+you\s+(get|source|import|buy)|source\s+farm|which\s+farm|imported?\s+from|who\s+supplies|who\s+breeds|bred\s+by|yaar\s+kitta|vaangu\w*)\b/,
  // Stock / quantity questions: answered with availability only, never a number.
  stock:
    /\b(how\s+many\b[^?.]*\b(left|remaining|available|in\s+stock|do\s+you\s+have|have\s+you\s+got|pieces|units|are\s+there|in\s+the\s+den|can\s+i\s+(buy|get|order)|on\s+hand)|exactly\s+how\s+many|how\s+many\s+exactly|(more|less|fewer)\s+than\s+\d+|at\s+least\s+\d+|\d+\s+(pieces?|pcs|nos?)\s+(available|irukk\w*)|quantity|qty|count(?=\s*\?)|count$|count\s+(of|left|available|irukk\w*)|pieces?\s+(left|available|remaining)|in\s+stock(?=\s*\?)|any\s+left|left\s+in\s+stock|stock\s+left|how\s+many\s+(fish|discus)\s+(do\s+you\s+have|are\s+there|left)|stock\s+(count|level|quantity|position|status)|quantity\s+(left|available)|how\s+much\s+stock|(what|which)\s+is\s+in\s+stock|in\s+stock\s+(now|today)|selling\s+fast|sold\s+out|almost\s+gone|last\s+one|only\s+(one|1|\d+)\b[^?.]*\bleft|\w+\s+left\s*\?|stock\s+(is\s+)?limited|limited\s+stock|plenty|enough\s+(for|of)|that\s+many|short\s+supply|running\s+out|(evlo|evvalavu|evlavu|evalo|ethana|ethanai)\b[^?.]*\b(irukk\w*|stock|left|pieces?|piece|fish)|(stock|pieces?)\s+(evlo|evvalavu|ethana)\w*)\b/,
  // Who owns / runs the Den (the site footer names the owner).
  owner:
    /\b(who\s+(is|'s|s)\s+(the\s+)?(owner|proprietor|founder|boss|person\s+behind|man\s+behind|guy\s+behind)|who\s+owns|who\s+runs|who\s+(started|founded|is\s+running|is\s+behind)\s+(the\s+den|this|the\s+(shop|store|business))|owner('?s)?\s+name|name\s+of\s+the\s+owner|are\s+you\s+the\s+owner|whose\s+(shop|store|business)|owner\s+(yaar|yaaru|evar)|(yaar|yaaru)\s+owner)\b/,
  human:
    /\b(are\s+(you|u)\s+(a\s+|an\s+)?(human|person|real|bot|robot|ai|machine|chatbot|automated)|is\s+this\s+(a\s+|an\s+)?(bot|human|real\s+person|ai|chatbot|robot|automated|person|live\s+chat)|am\s+i\s+(talking|chatting|speaking)\s+(to|with)|(you|u)\s+(a\s+)?(bot|robot)|(is\s+)?(this|it)\s+(a\s+)?(real\s+)?(person|human)\s+(replying|typing|answering|chatting)|is\s+(anyone|someone)\s+(real|actually)\s+(there|here|typing)|(bot|robot)\s+(hai|aa|ah|ya|or\s+(human|person|real))|(real|actual)\s+person\s+(or|replying|there))\b/,
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
    /\b(how\s+(do|can|to|should)\s+(i|we)\s+(order|buy|purchase|book)|how\s+to\s+(order|buy|purchase|book)|ordering|place\s+(an\s+)?order|order\s+process|process\s+to\s+(order|buy)|cart|shopping\s+bag|finali[sz]e|order\s+(eppadi|epdi|panradhu\s+eppadi|pannuradhu|pannanum)|eppadi\s+(order|vaang\w*)|vaang\w*\s+eppadi)\b/,
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

/**
 * Indian mobile: optional +91 / 91 / 0, then 10 digits starting 6–9. Returns +91XXXXXXXXXX.
 * LB-19 fix (Kiara #5): works on whole digit runs. A leading "+91" / "91 " / "0 " is a
 * prefix, never part of the number, so "+91 98765 000" (prefix + 8 digits) is NOT read
 * as 91 98765 000; it gets the polite recheck instead.
 */
const DIGIT_RUN = /(?<![\d+])(?:\+\s*)?\d(?:[\s-]{1,2}\d|\d)*/g;
function validTen(d: string): string | null {
  if (!/^[6-9]\d{9}$/.test(d)) return null;
  if (/^(\d)\1{7,}/.test(d) || /(\d)\1{7,}$/.test(d)) return null;
  if (d === "9876543210" || d === "6789012345") return null;
  return `+91${d}`;
}
function mobileFromRun(run: string): string | null {
  const plus = run.trimStart().startsWith("+");
  const groups = run.replace(/^\s*\+\s*/, "").split(/[\s-]+/).filter(Boolean);
  const digits = groups.join("");
  if (plus) return digits.startsWith("91") ? validTen(digits.slice(2)) : null; // +91 only
  if (groups.length > 1 && ["91", "0", "091"].includes(groups[0]!)) {
    // "91 98450 12345" / "0 98450 12345": the first group is a prefix.
    const rest = groups.slice(1);
    const whole = validTen(rest.join(""));
    if (whole) return whole;
    return spanOf(rest);
  }
  if (digits.length === 12 && digits.startsWith("91")) return validTen(digits.slice(2));
  if (digits.length === 11 && digits.startsWith("0")) return validTen(digits.slice(1));
  const whole = validTen(digits);
  if (whole) return whole;
  // Two things typed side by side ("2 9845012345", "9845012345 9845012346"): a whole-group span.
  return groups.length > 1 ? spanOf(groups) : null;
}
function spanOf(groups: string[]): string | null {
  for (let i = 0; i < groups.length; i += 1) {
    let d = "";
    for (let j = i; j < groups.length && d.length < 10; j += 1) {
      d += groups[j];
      if (d.length === 10) {
        const ok = validTen(d);
        if (ok) return ok;
      }
    }
  }
  return null;
}
export function extractIndianMobile(text: string): string | null {
  for (const m of text.matchAll(DIGIT_RUN)) {
    const phone = mobileFromRun(m[0]);
    if (phone) return phone;
  }
  return null;
}
/** Every phone-like digit run (7+ digits) blanked out (for reading the words around a number). */
function withoutDigitRuns(text: string): string {
  return text.replace(DIGIT_RUN, (r) => ((r.match(/\d/g) ?? []).length >= 7 ? " , " : r));
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

const FOOD_WORD = /\b(frozen|foods?|pellets?|heart\s+mix|bloodworms?|blood\s+worms?|feed|saapadu|unavu|khana)\b/;
const FISH_WORD = /\b(fish|fishes|meen|live\s+discus|discus\s+fish)\b|\bdiscus\b(?!\s+(frozen|foods?|pellets?|feed))/;

/** LB-11: "Are you looking for Discus fish or Discus frozen foods?" */
function parseLookingFor(t: string): string | null {
  if (/\b(both|everything|rendum|dono)\b/.test(t)) return LOOKING_BOTH;
  const food = FOOD_WORD.test(t);
  const fish = FISH_WORD.test(t.replace(/\bdiscus\s+(frozen\s+)?(foods?|pellets?)\b/g, " "));
  if (food && fish) return LOOKING_BOTH;
  if (food) return LOOKING_FOOD;
  if (fish || /^(the\s+)?(first|former|live)\b|\bfish\s+only\b/.test(t)) return LOOKING_FISH;
  if (/^(the\s+)?(second|latter)\b/.test(t)) return LOOKING_FOOD;
  if (/\b(not\s+sure|don'?t\s+know|undecided|either|maybe)\b/.test(t)) return "not sure";
  return null;
}

/** LB-11: the pointer after the fish-or-food answer (live site pages, 3 Oct 12:25 IST). */
function lookingForPointer(v: string | undefined): string | undefined {
  if (v === LOOKING_FISH) return ANSWERS.lookingForFish;
  if (v === LOOKING_FOOD) return ANSWERS.lookingForFood;
  if (v === LOOKING_BOTH) return ANSWERS.lookingForBoth;
  return undefined;
}

/** LB-9: "I'll visit" / "I will come" / "naan varen" at the delivery step = Chennai pickup. */
const VISIT_ANSWER =
  /\b(i'?ll|i\s+will|i\s+can|i\s+shall|we'?ll|we\s+will|will|gonna|going\s+to|planning\s+to)\s+(come|visit|drop\s+by|stop\s+by|walk\s+in|pick\s?-?up|collect)\b|\b(visit|visiting|in\s+person|walk[\s-]?in|self\s+pick\w*|store\s+pickup|come\s+(over|down|personally|to\s+(the|your)\s+(store|shop|place|den))|i'?m\s+coming|coming\s+(over|personally|to\s+(the|your)\s+(store|shop|place|den))|direct(ly)?\s+(come|varen|visit))\b|\b(naan|naane|naa|nan|nanu|naanga)\s+(varen|vaaren|varuven|vandhu\w*|varom|varuvom)\b|\b(varen|vaaren|varuven|neril\s+varen|nerla\s+varen|nera\s+varen|kadaikku\s+varen|vandhu\s+(vaangi|edu|eduth|collect)\w*|main\s+aaunga|aa\s+jaunga|khud\s+aaunga)\b/;

function parseDelivery(t: string): string | null {
  if (/\b(not\s+sure|don'?t\s+know|either|any|both)\b/.test(t)) return "not sure";
  if (/\b(train|rail|railway|ship|shipping|parcel|courier|send)\b/.test(t)) return "train shipping";
  if (/\b(pick\s?-?up|pickup|collect|come\s+(and\s+)?(take|get)|chennai)\b/.test(t) || VISIT_ANSWER.test(t)) return "Chennai pickup";
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
    case "lookingFor":
      return parseLookingFor(t) !== null;
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
  // LB-11: an explicit "frozen food" / "discus fish" mention fills the fish-or-food slot.
  if (!lead.lookingFor && !state.handoff.skip?.includes("lookingFor") && (FOOD_WORD.test(t) || /\b(discus\s+fish|live\s+(fish|discus))\b/.test(t))) {
    lead.lookingFor = parseLookingFor(t) ?? undefined;
  }
  if (!lead.delivery && /\b(train\s+shipping|by\s+train|chennai\s+pickup|pick\s?up\s+in\s+chennai)\b/.test(t)) {
    lead.delivery = /\btrain\b/.test(t) ? "train shipping" : "Chennai pickup";
  }
  if (!lead.timeline && /\btank\s+(is\s+)?(ready|cycled|set\s+up)\b/.test(t)) lead.timeline = "tank ready now";
}

/** Steps not to ask on this handoff (declined, skipped for the path, or not relevant). */
function skipStep(state: ChatState, step: HandoffStep): boolean {
  if (state.handoff.declined.includes(step) || state.handoff.skip?.includes(step)) return true;
  if (step === "delivery" && state.lead.inShipStates === false) return true;
  // LB-11: "is your tank ready?" means nothing to a frozen-food-only buyer.
  if (step === "timeline" && state.lead.lookingFor === LOOKING_FOOD) return true;
  return false;
}

function nextStep(state: ChatState): HandoffStep | null {
  for (const step of HANDOFF_ORDER) {
    if (skipStep(state, step)) continue;
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
    case "lookingFor":
      return ANSWERS.handoffAskLookingFor;
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
    if (skipStep(state, step)) continue;
    if (!state.lead[step]) return step;
  }
  return null;
}

function join(...parts: Array<string | undefined>): string {
  return parts.filter((p) => p && p.trim()).join("\n\n");
}

/** LB-11: per-path slot setup (see HANDOFF_KIND). */
function applyHandoffKind(state: ChatState, kind: ChatState["handoffKind"]): void {
  state.handoff.skip = kind === "claim" ? ["lookingFor"] : [];
  if (kind === "fish") state.lead.lookingFor ??= LOOKING_FISH;
  // LB-13: already answered after a greeting -> don't ask again.
  if (kind !== "claim" && state.lookingForHint && state.lookingForHint !== "not sure") state.lead.lookingFor ??= state.lookingForHint;
}

function startHandoff(state: ChatState, raw: string, prefix?: string, kind: ChatState["handoffKind"] = state.handoffKind): Turn {
  if (state.completed) {
    state.pendingOffer = null;
    return { reply: join(prefix, ANSWERS.handoffAlreadyDone), intent: "handoff_already_done" };
  }
  state.handoff.active = true;
  state.handoff.phoneTries = 0;
  state.handoff.declined = [];
  applyHandoffKind(state, kind);
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

/** LB-6 D2: a filter with no match points back to the page (no generic handoff offer). */
const NOTHING_MATCHES = "Nothing on our available page matches that right now. Full list: thediscusden.com/available.";

async function priceOrAvailability(state: ChatState, raw: string, t: string, ctx: Ctx, kind: "price" | "available" | "strain"): Promise<Turn | null> {
  const cards = await liveStrains(ctx);
  if (!cards) {
    state.pendingOffer = null; // LB-6 D2
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
      state.pendingOffer = null; // LB-6 D2
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
    state.pendingOffer = null; // LB-6 D2
    return {
      reply: NOTHING_MATCHES,
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
      state.pendingOffer = null; // LB-6 D2
      return {
        reply: NOTHING_MATCHES,
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

/** Buying several ("can I get 20 pieces?", "need 6 fish", "a few of them"). */
/** "can I get 20 pieces?" / "do you have 10?": a quantity ask, answered with availability only. */
const QTY_ASK =
  /\b(can|could|may)\s+(i|we)\s+(get|buy|order|have|take|book)\s+([2-9]|[1-9]\d+)\b(?!\s*(months?|weeks?|years?|days?|inch\w*|cm|"|'|\.\d))|\b(do\s+you\s+have|have\s+you\s+got|is\s+there|are\s+there)\s+([2-9]|[1-9]\d+)\b(?!\s*(months?|weeks?|years?|days?|inch\w*|cm|"|'|\.\d))|\b([2-9]|[1-9]\d+)\s*(pieces?|pcs|nos)\s*(available|possible|in\s+stock)?\s*\?/;
const SEVERAL =
  /\b([2-9]|[1-9]\d+)\s*(pieces?|pcs|nos|fish|discus|pairs?|of\s+(them|those|these))\b|\b(buy|get|order|take|need|want|book|have)\s+([2-9]|[1-9]\d+)\b|\b(several|multiple|bulk|a\s+few\s+of)\b/;

async function stockAnswer(state: ChatState, raw: string, t: string, ctx: Ctx): Promise<Turn> {
  const cards = await allStrains(ctx);
  if (!cards || !cards.length) {
    state.pendingOffer = null; // LB-6 D2
    return { reply: ANSWERS.stockFetchFailed, intent: "stock_fallback" };
  }
  const match = matchStrains(raw, cards);
  const chosenWords = new Set(match.cards.flatMap((c) => words(c.name)));
  const unmatchedVocab = strainWordsIn(t)
    .filter((w) => !COLOURS.includes(w))
    .filter((w) => !w.split(" ").every((x) => chosenWords.has(singular(x))));
  if (match.cards.length && !unmatchedVocab.length) {
    for (const c of match.cards) if (!state.interests.includes(c.name)) state.interests.push(c.name);
    // LB-6 (Shiva, 3 Oct): status only, then the site steps (+ volume line when buying several). No handoff.
    state.pendingOffer = null;
    const outro = SEVERAL.test(t) ? `${ANSWERS.stockOutro} ${VOLUME_DISCOUNT_LINE}` : ANSWERS.stockOutro;
    return { reply: join(match.cards.slice(0, 5).map(stockLine).join("\n"), outro, SITE_STEPS), intent: "stock_strain" };
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
    state.pendingOffer = null; // LB-6 D2
    return { reply: ANSWERS.stockFetchFailed, intent: "stock_fallback" };
  }
  // LB-6 (Shiva, 3 Oct): status only, then the site steps (+ volume line when buying several).
  state.pendingOffer = null;
  const listOutro = SEVERAL.test(t) ? `${ANSWERS.stockListOutro} ${VOLUME_DISCOUNT_LINE}` : ANSWERS.stockListOutro;
  return {
    reply: join(`${ANSWERS.stockIntro}\n${listed.slice(0, 5).map(stockLine).join("\n")}`, listOutro, SITE_STEPS),
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
  state.pendingOffer = null; // LB-6: no handoff offer
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
    state.pendingOffer = null; // LB-6 D2
    return { reply: ANSWERS.goatHeartPending, intent: "food_goat_pending" };
  }
  if (!foods.frozen && !foods.pellets) {
    state.pendingOffer = null; // LB-6 D2
    return { reply: ANSWERS.foodFetchFailed, intent: "food_fallback" };
  }
  const frozen = (foods.frozen ?? []).filter((f) => f.packs.length);
  const pellets = (foods.pellets ?? []).filter((f) => f.packs.length);
  const pending = (foods.frozen ?? []).some((f) => /goat\s*heart/i.test(f.name) && !f.packs.length);
  const parts: string[] = [];
  if (frozen.length) parts.push(`frozen foods (${frozen.map(foodLine).join("; ")})`);
  if (pellets.length) parts.push(pellets.map(foodLine).join("; "));
  if (!parts.length) {
    state.pendingOffer = null; // LB-6 D2
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
  state.pendingOffer = null; // LB-6 D2: no generic connect offer
  if (!yd) return { reply: ANSWERS.beginnerNotListed, intent: "beginner_handoff" };
  if (!state.interests.includes(yd.name)) state.interests.push(yd.name);
  return {
    reply: `${ANSWERS.beginnerIntro} ${yd.name}: ${yd.size}, ${yd.priceText} per piece.${yd.description ? ` ${yd.description.replace(/([^.!?])$/, "$1.")}` : ""} ${ANSWERS.beginnerOutro}`,
    intent: "beginner",
  };
}

// ---------------------------------------------------------------------------
// LB-5: requests for anything not on the stock page
// ---------------------------------------------------------------------------

/** Always a request for something not listed (sizes, ages, batches, custom...). */
const UNLISTED_STRONG = new RegExp(
  [
    String.raw`\b(baby|babies|juveniles?|fry|fingerlings?|younger|smaller|bigger|larger|tinier)\b`,
    String.raw`\bcoin[\s-]*(size|sized)\b|\bcoin\s+(discus|fish)\b`,
    String.raw`\b(breeders?|breeding|adult|mature|grown[\s-]?up|full[\s-]?grown)\s+(pairs?|discus|fish|ones?|size|stock)\b|\bbreeders?\s*pair\b`,
    String.raw`\b(any\s+other|other|different)\s+(sizes?|strains?|fish|discus|colou?rs?|variet\w+|options?|kinds?|types?|ages?)\b|\bany\s+other\s*\??\s*$`,
    String.raw`\b(coming\s+soon|next\s+batch|new\s+(batch|stock|arrivals?)|restock\w*|back\s+in\s+stock|when\s+will\s+you\s+(get|have)|future\s+stock|upcoming)\b`,
    String.raw`\bcan\s+(you|u)\s+(source|import|procure|arrange\s+(a|an|some|other|another)|get\s+(me\s+|us\s+)?(a|an|some|other|another|more|smaller|bigger)|bring\s+(me\s+)?(a|an|some|other|another))\b`,
    String.raw`\b(custom|customi[sz]ed|special\s+(request|order|size)|pre[\s-]?order|made\s+to\s+order|on\s+request)\b`,
    String.raw`\b(what|which)\s+age\b|\bhow\s+old\b|\b\d+\s*(months?|weeks?)\s+old\b`,
    String.raw`\b(chinna|chinnadhu|chinnathu|chinnadha|kutty|kutti|periya|periyadhu|periyathu|perusu)\b`,
    String.raw`\badutha\s+(batch|stock)\b|\bvera\s+(size|fish|variety|colou?r|strain|edhavadhu)\b|\bpudhu\s+(batch|stock)\b`,
  ].join("|"),
);
/** Cheaper / budget asks: only when not about shipping, payment or discounts. */
const UNLISTED_CHEAPER =
  /\b(cheaper|cheap\s+(one|ones|fish|discus|option)|budget|low(er)?\s+(price|priced|rate|cost)|less\s+(price|expensive|costly)|reduce\s+the\s+price|price\s+(kammi|kuraivu|kuraichu)|kammi\s*(price|rate|vilai|vela|la|ah)|(vilai|rate)\s+(kammi|kuraivu)|kuraivu\s*(price|vilai|rate|la))\b/;
const UNLISTED_CHEAPER_SKIP = /\b(ship\w*|deliver\w*|courier|transport|train|payment|pay|gpay|upi|discount|coupon|promo|code)\b/;
/** Vague size words: a request only next to a fish/size word (not "how big is ..."). */
const UNLISTED_WEAK = /\b(small|big|large|tiny|little|young|adult|mature)\s+(size|sized|ones?|discus|fish|pairs?|blue|red|yellow|white|albino|tiger|wild|panda|galaxy|marlboro|panthera|diamonds?|ninja|turquoise\w*|checker\w*|snakeskin|scorpion|butterfly|vipers?|eagles?)\b|\b(size|sizes)\s+(small|big|large|tiny)\b/;
const UNLISTED_NOT_FISH = /\b(tank|aquarium|food|pellets?|heart\s+mix|bloodworms?|feed|filter|heater|box|bag|order\s+size)\b/;
const INCH_ASK = /\b(\d+(?:\.\d+)?)\s*(?:inch|inches|in\b|")/;

export type UnlistedKind = "strong" | "cheaper" | "weak" | "inch";

/** Which kind of "not listed" request a message is (null = none). */
export function unlistedAsk(t: string): UnlistedKind | null {
  if (UNLISTED_STRONG.test(t) && !UNLISTED_NOT_FISH.test(t.replace(UNLISTED_STRONG, " "))) return "strong";
  if (UNLISTED_CHEAPER.test(t) && !UNLISTED_CHEAPER_SKIP.test(t)) return "cheaper";
  if (UNLISTED_WEAK.test(t) && !UNLISTED_NOT_FISH.test(t)) return "weak";
  if (INCH_ASK.test(t) && !UNLISTED_NOT_FISH.test(t)) return "inch";
  return null;
}

async function unlistedFirm(state: ChatState, raw: string, t: string, ctx: Ctx): Promise<Turn | null> {
  const kind = unlistedAsk(t);
  if (!kind) return null;
  if (kind === "weak" || kind === "inch") {
    // Exact listed match keeps the normal reply ("Blue Diamonds Small", "3 inch Blue Diamond").
    const cards = await liveStrains(ctx);
    if (cards) {
      const matched = matchStrains(raw, cards).cards;
      if (kind === "weak") {
        const w = /\b(small|big|large|tiny|little|young|adult|mature)\b/.exec(t)?.[1];
        const q = w === "large" ? "big" : w;
        if (matched.some((c) => cardKeys(c).qualifier === q)) return null;
      } else {
        const n = Number(INCH_ASK.exec(t)![1]);
        const pool = matched.length ? matched : cards;
        if (pool.some((c) => { const r = sizeRange(c.size); return r !== null && n >= r[0] && n <= r[1]; })) return null;
      }
    }
  }
  state.pendingOffer = null;
  return { reply: ANSWERS.unlistedFirm, intent: "unlisted_firm" };
}

// ---------------------------------------------------------------------------
// LB-6: steer to the site; SOP for first-timers / outside Chennai
// ---------------------------------------------------------------------------

const SOP_BLOCK = `${ANSWERS.sopIntro}\n${ANSWERS.sop}`;
const CHENNAI = /\b(chennai|madras)\b/;
/** Pushes to reach a person, beyond the classic talkToShiva phrasings (English + Tanglish). */
const HUMAN_PUSH = new RegExp(
  [
    String.raw`\b(talk|speak|chat)\s+(to|with)\s+(a\s+|the\s+|some\s+)?(human|person|someone|somebody|owner|manager|agent|staff|real\s+(human|person)|actual\s+person|boss)\b`,
    String.raw`\b(need|want|wanna|have)\s+to\s+(talk|speak)\b|\blet\s+me\s+(talk|speak)\b|\bcan\s+i\s+(talk|speak|call)\b`,
    String.raw`\b(human|person)\s+(please|pls|plz|only|agent)\b|\breal\s+(human|people)\b|\blive\s+(agent|person|chat)\b|\bcustomer\s+(care|service|support)\b`,
    String.raw`\b(give|send|share|tell)\s+(me\s+)?(your|his|the\s+owner'?s?|owner'?s?|shiva'?s?)\s+(number|phone|contact|mobile|whatsapp|email)\b|\bowner'?s?\s+(number|contact|phone|mobile|whatsapp|email)\b`,
    String.raw`\b(anyone|anybody|someone)\s+(there|available|real|from\s+the\s+den)\b|\bnot\s+a\s+bot\b|\b(no|stop)\s+(the\s+)?bot\b|\bdon'?t\s+want\s+(a\s+|the\s+|to\s+talk\s+to\s+a\s+)?bot\b|\bi\s+want\s+(a\s+)?(human|person|shiva|the\s+owner)\b`,
    String.raw`\bcall\s+me\b|\bcall\s+(back|now|asap)\b|\bconnect\s+(me|us)\b|\burgent\w*\b[^.?!]*\b(connect|call|talk|speak|shiva|owner|human)\b|\bplease\s+connect\b`,
    // LB-6 A11: basic Hinglish pushes (reply stays English; Hindi replies are BL-1).
    String.raw`\b(owner|shiva|malik|maalik|insaan|insan|aadmi|admi|banda|bande|kisi|kisi\s+(insaan|insan|aadmi|admi|bande))\s+(se|say|ko)\s+(baat|bat|baath)\b|\b(baat|bat)\s+(karao|karwao|krao|karvao|karwa\s+do|kara\s+do|karni\s+hai|karna\s+hai|krni\s+hai|karni|karna|karunga|karna\s+chahta|karna\s+chahti)\b|\b(number|phone\s+number|contact|mobile\s+number)\s+(do|dedo|de\s+do|dijiye|dena|bhejo|bhej\s+do|chahiye|milega)\b|\b(call|phone)\s+(karo|karna|kar\s+do|karwao|kijiye|karein)\b|\b(insaan|insan|aadmi|admi|human|asli\s+(insaan|aadmi))\s+(chahiye|se\s+baat|bhejo)\b`,
    String.raw`\b(owner|shiva|ungal\s+owner|anna)\s+kitta\s+(pesa\w*|pesu\w*|connect|call)\b|\b(owner|shiva)\s+(number|contact)\s+(kudunga|kudu|venum|tharunga|anuppunga)\b|\b(pesanum|pesa\s+venum|pesa\s+mudiyuma|pesalama|pesunga)\b|\bcall\s+(pannunga|pannu|panna\s+mudiyuma|pannalama)\b|\b(aal|aalu|manushan)\s+(venum|kitta)\b`,
  ].join("|"),
);
// ---------------------------------------------------------------------------
// LB-14 (Shiva, 3 Oct): "Connect to Shiva", "put me through", "get me the owner",
// "how do I contact the owner"... with typos ("conect", "speek", "tlak").
// ---------------------------------------------------------------------------
const REACH_TARGET = new Set(["shiva", "siva", "shivaa", "sivaa", "owner", "ownr", "onwer", "owener", "someone", "somebody", "anyone", "anybody", "person", "human", "humans", "manager", "him", "staff", "boss", "agent", "proprietor", "team"]);
const REACH_LONG = ["connect", "contact", "speak", "reach"];
const REACH_SHORT = ["talk", "call", "ring", "ping", "phone"];
/** Verbs whose object may be "you" ("how can I contact you"); "talk to you about tanks" is not a push. */
const REACH_YOU = new Set(["connect", "contact", "reach", "call", "phone", "ring"]);
/** Verbs whose object may be "me" ("conect me", "call me"); "the fish reach me" is not a push. */
const REACH_ME = new Set(["connect", "call", "phone", "ring"]); // not "contact": "who will contact me?" is B6

/** Damerau-Levenshtein distance (words are short, so this stays fast). */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}
function sortedLetters(w: string): string {
  return [...w].sort().join("");
}
/** "taalk" -> "talk", "connnect" -> "connect": collapse runs of the same letter. */
function squeeze(w: string): string {
  return w.replace(/(.)\1+/g, "$1");
}
/** w is v with exactly one letter left out ("cal" for "call", "conect" for "connect"). */
function droppedOne(w: string, v: string): boolean {
  if (w.length !== v.length - 1) return false;
  for (let i = 0; i < v.length; i++) if (v.slice(0, i) + v.slice(i + 1) === w) return true;
  return false;
}
/**
 * The reach verb a word stands for. Long verbs (connect, contact, speak, reach): exact,
 * doubled letters, or one dropped / wrong / swapped letter. Short verbs (talk, call...):
 * exact, doubled letters ("taalk"), one dropped letter ("cal") or a swapped pair ("tlak"),
 * but never a different letter, so "walk", "tall" and "tell" stay out.
 */
function reachVerb(w: string): string | null {
  const base = w.replace(/(ing|ed|s)$/, "");
  for (const v of [...REACH_LONG, ...REACH_SHORT]) if (w === v || base === v || squeeze(w) === squeeze(v)) return v;
  // Typos keep the first letter ("teach", "beach", "all", "walk" never count).
  if (w.length >= 4) {
    for (const v of REACH_LONG) {
      if (w[0] !== v[0]) continue;
      if (editDistance(w, v) <= 1 || editDistance(base, v) <= 1 || editDistance(squeeze(w), v) <= 1) return v;
    }
  }
  for (const v of REACH_SHORT) {
    if (w[0] !== v[0]) continue;
    if (w.length === v.length && sortedLetters(w) === sortedLetters(v) && editDistance(w, v) === 1) return v;
    if (w.length >= 3 && (droppedOne(w, v) || droppedOne(squeeze(w), v))) return v;
  }
  return null;
}
const REACH_PHRASE =
  /\bput\s+(me|us)\s+through\b|\bget\s+(me|us)\s+(through\s+to\s+|to\s+)?(the\s+|a\s+|an\s+|some\s+)?(shiva|siva|owner|someone|somebody|person|human|manager|boss|staff|him|real\s+person)\b|\b(get|be|keep)\s+in\s+touch\b|^(shiva|siva)(\s+(please|pls|plz|sir|anna|now))?$|^(the\s+)?(owner|human|a\s+human|real\s+person|manager|a\s+person)\s+(please|pls|plz|now)$/;
/** LB-14 (Kiara 8a88e4e): "I need a human now", "want a real person", "human please", "any human there?". */
const HUMAN_ASK =
  /\b(need|want|get|give|send|bring)\s+(me\s+)?(a\s+|an\s+|some\s+|to\s+(talk|speak|chat)\s+(to|with)\s+(a\s+)?)?(real\s+|actual\s+|live\s+|proper\s+)?(human|person|human\s+being|people)\b(?!\s+(to|for|who|at)\s+(?!(talk|speak|chat|help)\b))|\b(human|real\s+person|person)\s+(please|pls|plz|now|asap|here|needed)\b|\b(any|a|some)\s*(human|real\s+person|person|one|body)\s+(there|here|around|available|online)\b|\bis\s+there\s+(a\s+|any\s+)?(human|real\s+person|person|anyone|anybody|someone)\b|^(human|a\s+human|real\s+person|a\s+real\s+person)\s*\??$/;
/** An explicit person in the message (used to keep "can I call to visit the store" on the visit answer). */
const PERSON_WORD = /\b(shiva|siva|owner|someone|somebody|anyone|person|human|manager|him|staff|boss|agent)\b/;

/** LB-14: an ask to reach Shiva / a person that the LB-6 patterns miss. */
export function isReachAsk(t: string): boolean {
  if (REACH_PHRASE.test(t) || HUMAN_ASK.test(t)) return true;
  const words = t.replace(/[^a-z' ]/g, " ").split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const verb = reachVerb(words[i]!);
    if (!verb) continue;
    for (const w of words.slice(i + 1, i + 6)) {
      if (REACH_TARGET.has(w.replace(/'s$/, ""))) return true;
      if ((w === "you" || w === "u") && REACH_YOU.has(verb)) return true;
      if (w === "me" && REACH_ME.has(verb)) return true;
    }
  }
  return false;
}

/**
 * LB-15 (Shiva, 3 Oct 12:49 PM): 1st push = full steer, 2nd = short steer, 3rd = the
 * polite "Understood. Kindly place your requirement..." reply, 4th+ = rotate its variants.
 * Never the same reply twice in a row; never a handoff.
 */
// ---------------------------------------------------------------------------
// LB-19: name + WhatsApp capture (persuasion). Max 2 asks per chat, never pushy.
// ---------------------------------------------------------------------------

/**
 * Intents that count as a real-interest question: price, strain, delivery, visit.
 * LB-22: plus buy / order / pay intent ("how to order and pay online"). Delivery-location
 * replies inside the 8 states already ask; outside them the care-first handoff offer already asks.
 */
const INTEREST_INTENT =
  /^(?:(?:price|available|strain|stock)_(?!fallback$)\w+|ship_(?:general|in_states|cost|how)|delivery_timing\w*|visit|pickup|station_pickup|per_piece|ordering|how_to_pay|pay_advance|order_in_chat|how_many_to_buy)$/;

function contactAsk(state: ChatState): NonNullable<ChatState["contactAsk"]> {
  return (state.contactAsk ??= { count: 0, lastTurn: 0, pending: false, declined: false });
}

type RotKind = keyof NonNullable<ChatState["askRot"]>;
function nextRot(state: ChatState, kind: RotKind): number {
  const rot = (state.askRot ??= {});
  const k = rot[kind] ?? 0;
  rot[kind] = k + 1;
  return k;
}

/**
 * LB-22/24: the personal ask for what this chat still needs. Only details typed IN THIS
 * CHAT count (never anything from an earlier chat). Number only -> the name; name only ->
 * the number (by name); neither -> name + number. `later` (LB-25, 3rd+ human request):
 * one composed ask sentence + a "Shiva will get back to you personally" note.
 * Never says the details were passed. Sets the matching pending flags.
 */
function personalAsk(state: ChatState, later = false): string {
  const a = contactAsk(state);
  a.pending = true;
  const { name, phone } = state.lead;
  const kind: "both" | "phone" | "name" = phone ? "name" : name ? "phone" : "both";
  if (kind === "name") a.awaitingName = true;
  if (later) return ANSWERS.humanAskLater(kind, nextRot(state, "later"), name);
  if (kind === "name") return ANSWERS.humanAskName(nextRot(state, "name"));
  if (kind === "phone") return ANSWERS.humanAskPhone(name!, nextRot(state, "phone"));
  return ANSWERS.humanAskBoth(nextRot(state, "both"));
}

/**
 * LB-22 + LB-25 (Shiva, 8 Oct): EVERY "talk / connect to Shiva / a human / the owner" request:
 *  - a valid name + number typed in this chat -> "passed to Shiva, he'll get back personally"
 *    (rotated, never re-asks);
 *  - otherwise the ask for the missing piece, never capped; from the 3rd request the ask carries
 *    the "Shiva will get back to you personally" note (LB-15's form line is no longer used here).
 * The request still uses up an interest ask (the max-2 cap on interest-triggered asks).
 */
function contactOrPush(state: ChatState): Turn {
  state.humanPushes = (state.humanPushes ?? 0) + 1;
  if (state.lead.name && state.lead.phone) {
    return { reply: ANSWERS.humanPassed(state.lead.name, nextRot(state, "passed")), intent: "human_push" };
  }
  const a = contactAsk(state);
  a.count += 1;
  a.lastTurn = state.turns;
  return { reply: personalAsk(state, state.humanPushes >= 3), intent: "human_push" };
}

/** After a real-interest answer: append the ask (1st: photos; 2nd, a later interest turn: Shiva gets back personally; LB-21). */
function maybeAppendAsk(state: ChatState, turn: Turn): Turn {
  if (!INTEREST_INTENT.test(turn.intent)) return turn;
  if (state.lead.phone || state.completed || state.handoff.active || state.pendingOffer === "lookingFor") return turn;
  const a = contactAsk(state);
  if (a.count >= 2 || a.pending) return turn;
  if (a.count === 1 && state.turns - a.lastTurn < 2) return turn;
  // LB-19 fix (Kiara #4): the ask REPLACES a trailing offer ("Want me to narrow it down by
  // size or colour?" after a strain list, "Shall I pass your details?" after a visit /
  // pickup / unlisted-strain answer), so the first strain or visit question gets the
  // name + WhatsApp ask instead of the old offer, and never two questions at once.
  // A "yes" to a visit / pickup / unlisted-strain ask still opens the guided handoff (the
  // LB-9 visit flow), so the 'handoff' offer stays pending; the strain-list 'narrow' offer
  // is dropped (a "yes" then gets "Please type your name and WhatsApp number here.").
  let reply = turn.reply;
  if (state.pendingOffer) {
    reply = stripOffer(reply.replace(/\n?Want me to narrow it down by size or colou?r\?\s*$/, "")).trim();
    if (state.pendingOffer === "narrow") state.pendingOffer = null;
  }
  a.count += 1;
  a.lastTurn = state.turns;
  a.pending = true;
  // LB-22: a name typed in this chat ("I am Arjun from ...") -> the number ask by name.
  if (state.lead.name) return { ...turn, reply: join(reply, personalAsk(state)) };
  return { ...turn, reply: join(reply, a.count === 1 ? ANSWERS.contactAskPhotos : ANSWERS.contactAskReserve) };
}

const CONTACT_FILLER: RegExp[] = [
  // LB-19 fix (Kiara #6): "You can reach me on ...", "feel free to call me at ...", "drop a message to ..."
  /\b(?:you|u)\s+(?:can|could|may)\s+(?:also\s+)?(?:reach|call|contact|message|msg|text|ping|whatsapp|wa|find|get|catch)(?:\s+(?:me|us))?(?:\s+(?:on|at|in|via|through))?\b/gi,
  /\b(?:feel\s+free\s+to|do|please|pls|kindly|just)?\s*(?:call|message|msg|ping|text|reach|contact|whatsapp|wa|drop\s+(?:a\s+)?(?:message|msg|text|hi|line))\s+(?:me|us|to)(?:\s+(?:on|at|in|via|through))?\b/gi,
  /\b(?:i\s+am|i'm|im)\s+(?:on|reachable\s+(?:on|at)|available\s+(?:on|at))\b/gi,
  /\b(?:my\s+)?(?:whats\s*app|whatsapp|wa|mobile|mob|cell|phone|ph|contact|number|num|no)\b\.?(?:\s*(?:is|:|-|=))?/gi,
  /\b(?:here'?s|here\s+is|please|pls|plz|kindly|thanks?|thank\s+you|ok|okay|sure|yes|hi|hello|hey|vanakkam)\b/gi,
];
/** Words that are never part of a name typed next to a number. */
const NOT_NAME_WORDS = new Set([
  "you", "u", "your", "can", "could", "may", "will", "would", "shall", "should", "me", "my", "mine", "us", "our", "we", "it", "is", "are",
  "was", "on", "at", "in", "via", "to", "reach", "call", "contact", "message", "msg", "text", "ping", "whatsapp", "drop", "send", "find",
  "get", "catch", "also", "free", "feel", "do", "just", "this", "that", "number", "mobile", "phone", "available", "reachable", "anytime",
  "any", "time", "evening", "morning", "after", "before", "pm", "am", "only", "or", "best", "same", "below", "above", "he", "him", "she",
  "they", "them", "if", "need", "want", "interested", "buy", "order", "please", "details", "photos", "videos", "pics",
]);

/** LB-24: the visitor asks the bot to show their own saved details. */
const PRIVACY_ASK =
  /\b(what('?s|\s+is|\s+was|\s+are)\s+my\s+(phone(\s+number)?|number|mobile(\s+number)?|whatsapp(\s+number)?|contact(\s+number|\s+details)?|name|details|email)|what\s+(number|phone\s+number|name|details|contact|whatsapp\s+number)\s+(do\s+you\s+have|have\s+you\s+got|did\s+i\s+(give|share|type|send|say)|is\s+saved|have\s+you\s+saved)|(repeat|read|tell|show|confirm|give)\s+(me\s+)?(back\s+)?my\s+(details|number|phone(\s+number)?|name|contact|whatsapp(\s+number)?)|do\s+you\s+(have|know|remember)\s+my\s+(number|phone(\s+number)?|name|details|whatsapp)|which\s+number\s+(did\s+i|do\s+you|have\s+you)|my\s+details\s+(back|please))\b/;

/** LB-22: a person-seeking message (talk / connect / reach Shiva, a human, the owner...). */
function isPersonRequest(t: string): boolean {
  return RE.talkToShiva.test(t) || RE.human.test(t) || HUMAN_PUSH.test(t) || isReachAsk(t);
}

/** LB-22: "hmm" / "umm" / "nope" after an ask is not a name (the bot now uses the name in its next ask). */
const FILLER_REPLY = /^(h+m+|u+m+|a+h+|o+h+|e+r+m*|ok+|k+|lol|haha\w*|wow|nice|cool|fine|sure|maybe|idk|nothing|nope|nah|hmm+\s+ok)$/;

/** Words that follow "I am" / "I'm" / "this is" but are never a name. */
const NOT_INTRO_NAME = new Set([
  "a", "an", "the", "not", "new", "looking", "interested", "from", "in", "at", "on", "here", "there", "also", "just", "fine", "good",
  "ok", "okay", "great", "well", "sure", "sorry", "glad", "happy", "back", "ready", "done", "based", "staying", "living", "planning",
  "going", "beginner", "newbie", "novice", "hobbyist", "keeper", "student", "buying", "very", "so", "really", "still", "free", "busy",
  "online", "available", "confused", "located", "settled", "excited", "worried", "curious", "keen", "serious", "tired", "scared",
  "satisfied", "impressed", "convinced", "urgent", "amazing", "helpful", "expensive", "costly", "correct", "right", "wrong", "same",
  "sure", "alone", "married", "retired", "indian", "tamil", "it", "this", "that", "what", "how", "your", "you", "me", "him", "her",
  "first", "second", "time", "today", "now", "already", "only", "about", "with", "into", "near", "outside", "inside", "abroad",
  "customer", "buyer", "reseller", "dealer", "shop", "owner", "shiva", "thinking", "asking", "calling", "writing", "trying", "waiting",
]);
/**
 * LB-22: a volunteered name: "I am Arjun from Bangalore", "I'm Priya, my number is ...",
 * "My name is Ravi Kumar", "myself Arjun". "I am" / "this is" only take a capitalised
 * word, or one followed by "from" / "here" / a comma; never "I am new / interested /
 * looking / from ...", never a place or a strain. ("You can reach me" never names: no "I am".)
 */
export function introName(raw: string): string | null {
  const s = withoutDigitRuns(raw);
  const explicit = /\b(?:my\s+name\s+is|my\s+name's|name\s+is|myself|call\s+me)\s+([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+)?)/i.exec(s);
  const intro = /\b(?:i\s+am|i'm|im|this\s+is)\s+([A-Za-z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+)?)(?=\s*(?:$|[,.!?;:]|\s(?:from|here)\b))/i.exec(s);
  const m = explicit ?? intro;
  if (!m) return null;
  let words = m[1]!.split(/\s+/);
  if (explicit) {
    const stop = words.findIndex((w) => /^(from|here|and|my|i|in|at)$/i.test(w));
    if (stop >= 0) words = words.slice(0, stop);
  } else if (!/^[A-Z]/.test(words[0]!) && !/^\s*(?:,|\s(?:from|here)\b)/i.test(s.slice(m.index + m[0].length))) {
    return null;
  }
  if (!words.length) return null;
  if (words.some((w) => NOT_INTRO_NAME.has(w.toLowerCase()) || NOT_NAME_WORDS.has(w.toLowerCase()) || /ing$/i.test(w))) return null;
  const name = words.join(" ");
  if (NAME_BLOCK.test(name) || findPlace(norm(name)) || strainWordsIn(norm(name)).length) return null;
  return titleCase(name.toLowerCase());
}

/** LB-22: a volunteered city ("from Bangalore", "I'm in Pune") kept for the email (same rule as the handoff prefill). */
function prefillCity(state: ChatState, t: string): void {
  if (state.lead.city || state.handoff.active) return;
  const place = findPlace(t);
  if (!place || place.zone !== "in" || !/\b(in|from|at|live|stay|staying|based)\b/.test(t)) return;
  if (/^(tamil nadu|tamilnadu|kerala|karnataka|andhra pradesh|telangana|maharashtra|madhya pradesh|odisha|orissa)$/.test(place.name)) return;
  state.lead.city = titleCase(place.name);
  state.lead.stateName ??= place.state;
}

/** LB-19: a name typed next to the number ("Ravi 98450 12345", "I'm Ravi, my number is ..."). */
export function nameNearNumber(raw: string): string | null {
  let s = withoutDigitRuns(raw);
  for (const re of CONTACT_FILLER) s = s.replace(re, " ");
  for (const seg of s.split(/[,;\n]|\band\b|&/i)) {
    const piece = seg.replace(/\s+/g, " ").replace(/^[\s\-–—:.]+|[\s\-–—:]+$/g, "").trim();
    if (piece.length < 2) continue;
    const name = parseName(piece);
    if (!name || name.length < 2) continue;
    if (name.toLowerCase().split(/\s+/).some((w) => NOT_NAME_WORDS.has(w))) continue;
    if (!findPlace(norm(name)) && !strainWordsIn(norm(name)).length) return name;
  }
  return null;
}

/** LB-19 human check: a phone-like digit run that is NOT a valid 10-digit Indian mobile. */
export function looksLikeBadNumber(raw: string): boolean {
  if (extractIndianMobile(raw)) return false;
  if (/(₹|\brs\.?\s*|\binr\b)\s*\d/i.test(raw)) return false;
  const runs = raw.match(/\+?\d[\d\s-]{4,18}\d/g) ?? [];
  return runs.some((r) => {
    const d = r.replace(/\D/g, "");
    if (/^\d{1,2}[\s-]\d{1,2}[\s-]\d{2,4}$/.test(r.trim())) return false; // a date
    // "+91 98765 000" / "91 98765 000": a country code with too few digits after it.
    if (/^\+\s*91|^91[\s-]/.test(r.trim()) && d.length >= 7) return true;
    return d.length >= 8 && d.length <= 13;
  });
}

/** LB-19: reply to a captured number (closing message when the name is known too). */
function contactAck(state: ChatState): Turn {
  const a = contactAsk(state);
  a.pending = false;
  if (state.lead.name) {
    state.completed = true;
    a.awaitingName = false;
    return { reply: ANSWERS.handoffClose(state.lead.name), intent: "contact_saved", completedNow: true };
  }
  a.awaitingName = true;
  return { reply: ANSWERS.contactNeedName, intent: "contact_saved_need_name" };
}

/** LB-19: thanks / bye / ok on its own (kept as a helper; since the fix round every message within 10 min of the closing message stays in that chat). */
export function isCourtesyOnly(text: string): boolean {
  const t = norm(text);
  if (!t || t.length > 60) return false;
  const p = pleasantryOnly(t);
  if (p === "thanks" || p === "bye") return true;
  return /^(ok|okay|k|kk|sure|great|cool|fine|noted|done|super|nice|good|alright|all\s+right|thanks?|thank\s+you|thx|ty|bye|tata|nandri|seri|sari)(\s+(ok|okay|thanks?|thank\s+you|bye|shiva|sir|anna|bro|da|so\s+much|a\s+lot))*[\s!.,]*$/.test(t);
}

// ---------------------------------------------------------------------------
// LB-13: pleasantries (greeting / thanks / bye / "I'm new") on their own.
// A pleasantry with a real question ("hi, price of blue diamond?") is not one.
// ---------------------------------------------------------------------------
type Pleasantry = "greeting" | "thanks" | "bye" | "new";
const PLEASANTRY: Array<[Pleasantry, RegExp]> = [
  ["bye", /\b(bye(\s+bye)?|byee+|goodbye|good\s+bye|see\s+(you|u|ya)(\s+(later|soon|again))?|good\s*night|tata|take\s+care|catch\s+you\s+later|cya)\b/g],
  ["thanks", /\b(thanks?(\s+(a\s+lot|so\s+much|very\s+much|again|a\s+ton))?|thank\s+(you|u)(\s+(so|very)\s+much|\s+a\s+lot)?|thanku|thankyou|thx|thnx|thanx|tnx|ty|nandri|dhanyavad|shukriya|much\s+appreciated|appreciate\s+it)\b/g],
  ["new", /\b((i'?m|i\s+am|im|am)\s+(a\s+|an\s+)?(new|beginner|newbie|novice|fresher|starter)(\s+(discus\s+)?(hobbyist|keeper|aquarist|fish\s*keeper|here|to\s+(the\s+)?(discus|hobby|fishkeeping|fish\s+keeping|this\s+hobby|discus\s+keeping)))?|(new|beginner|newbie|novice)\s+(discus\s+)?(hobbyist|keeper|aquarist|fish\s*keeper)(\s+here)?|(beginner|newbie|new)\s+here|new\s+to\s+(this\s+|the\s+)?(discus|hobby|fishkeeping|fish\s+keeping|aquariums?|discus\s+keeping|this)|just\s+(started|starting|getting\s+started)(\s+with\s+discus)?)\b/g],
  ["greeting", /\b(hi+|hello+|helo|hey+|hai|hiya|heya|howdy|vanakkam|namaste|namaskaram|namaskar|good\s+(morning|afternoon|evening|day)|gm|hola|greetings)\b/g],
];
const PLEASANTRY_FILLER =
  /\b(there|sir|madam|mam|maam|team|shiva|siva|anna|bro|all|everyone|guys|folks|friend|friends|dear|ji|ok|okay|oh|so|and|very|much|again|the|discus|den|from|here|just|a|an|to|you|too|i|am|im|i'm|really|nice|great|cool|lovely|wonderful)\b/g;

/** LB-13: which pleasantry this message is, if it is nothing but pleasantries. */
export function pleasantryOnly(t: string): Pleasantry | null {
  let rest = t;
  const kinds = new Set<Pleasantry>();
  for (const [kind, re] of PLEASANTRY) {
    rest = rest.replace(re, () => {
      kinds.add(kind);
      return " ";
    });
  }
  if (!kinds.size) return null;
  rest = rest.replace(PLEASANTRY_FILLER, " ").replace(/[^a-z0-9]+/g, "");
  if (rest) return null;
  for (const k of ["bye", "new", "thanks", "greeting"] as const) if (kinds.has(k)) return k;
  return null;
}

function pleasantryReply(state: ChatState, kind: Pleasantry): Turn {
  state.pendingOffer = null;
  // Bye: just a warm goodbye (a question would read oddly as they leave).
  if (kind === "bye") return { reply: ANSWERS.bye, intent: "bye" };
  // LB-19 fix (Kiara #2): after the closing message (or with the number known), "thanks" is just a thanks.
  // LB-22: also once the bot has asked for name + number this chat ("okay, thanks" is a plain thanks).
  const known = state.askedLookingFor || state.lookingForHint || state.lead.lookingFor || state.handoff.active || state.completed || Boolean(state.lead.phone) || (state.contactAsk?.count ?? 0) > 0;
  const lead = kind === "new" ? ANSWERS.welcomeNewHobbyist : kind === "thanks" ? ANSWERS.youreWelcome : ANSWERS.welcomeGreeting;
  const intent = kind === "new" ? "welcome_new" : kind === "thanks" ? "thanks" : "welcome";
  if (known) {
    return { reply: kind === "thanks" ? ANSWERS.thanks : kind === "new" ? `${ANSWERS.welcomeNewHobbyist} How can I help?` : ANSWERS.welcome, intent };
  }
  state.askedLookingFor = true;
  state.pendingOffer = "lookingFor";
  return { reply: `${lead} ${ANSWERS.handoffAskLookingFor}`, intent };
}

// ---------------------------------------------------------------------------
// LB-28 (Shiva, 8 Oct 6:10 PM): a greeting + intro and/or "I love discus" + intent in ONE
// message ("Hi - I am Shruti. I love Discus keeping and am planning to buy Discus.").
// Root cause of the 'didn't catch that': greetings, intros and "I love discus" were only
// recognised as the WHOLE message (pleasantry / welcome / name_given rules), and buy intent
// only as "want to buy / looking for ... discus", so the leftover clauses made every rule miss.
// Now the social part is answered warmly (by name) and the rest is routed on its own.
// ---------------------------------------------------------------------------
/** LB-28 / LB-22: buy intent beyond "want to buy discus" (planning / looking / thinking of ...). */
const BUY_PLAN =
  /\b(?:plan(?:ning|ned)?|want(?:ing)?|wanna|looking|thinking|keen|interested|hoping|intend(?:ing)?|would\s+(?:like|love)|i'?d\s+(?:like|love)|eager|ready|going)\s+(?:to|of|on|in)\s+(?:buy(?:ing)?|purchas(?:e|ing)|get(?:ting)?\s+(?:some|a|few|my|new|discus|fish|pairs?|them|one|two|three|\d)|bring(?:ing)?\s+home)\b|\bgetting\s+(?:some|a\s+few|a\s+pair\s+of|a\s+couple\s+of|my\s+first|new)\s+(?:discus|fish)\b|\b(?:buy|buying)\s+(?:some|a\s+few|a\s+pair\s+of|a\s+couple\s+of)\s+discus\b/;
const NOT_BUY = /\b(?:not|don'?t|do\s+not|never|no\s+longer|won'?t)\s+(?:\w+\s+){0,2}?(?:plan|want|look|think|keen|interest|hop|intend|like|buy|get)/;
function isBuyIntent(t: string): boolean {
  return BUY_PLAN.test(t) && !NOT_BUY.test(t);
}
/** LB-28: "I love discus (keeping)", "I keep discus", "discus lover here", "I'm a discus keeper". */
const KEEPER_RE =
  /\b(?:i\s+(?:really\s+|absolutely\s+|just\s+|truly\s+)?(?:love|adore|like|enjoy)\s+(?:keeping\s+)?(?:discus(?:es)?|discus\s+fish)(?:\s+(?:keeping|fish|hobby|so\s+much|a\s+lot|very\s+much))*|i\s+(?:keep|have\s+kept|have\s+been\s+keeping|am\s+keeping|'m\s+keeping)\s+discus(?:\s+fish)?(?:\s+(?:for\s+(?:a\s+few\s+|many\s+|some\s+)?(?:years?|months?|a\s+while|long)))?|(?:i'?m|i\s+am|im)\s+(?:a\s+|an\s+)?(?:big\s+)?(?:discus\s+)(?:keeper|lover|hobbyist|enthusiast|fan)|discus\s+(?:lover|keeper|enthusiast|hobbyist|fan)(?:\s+here)?|passionate\s+about\s+discus|(?:a\s+)?big\s+fan\s+of\s+discus)\b/gi;
const GREET_WORD = /\b(hi+|hello+|helo|hey+|hai|hiya|heya|howdy|vanakkam|namaste|namaskaram|namaskar|good\s+(?:morning|afternoon|evening|day)|greetings)\b/gi;
function greetEcho(t: string): string {
  const m = /\b(hi+|hello+|helo|hey+|hai|hiya|heya|howdy|vanakkam|namaste|namaskaram|namaskar|good\s+(morning|afternoon|evening|day)|greetings)\b/.exec(t);
  if (!m) return "Hi";
  if (m[2]) return `Good ${m[2]}`;
  if (/^hel/.test(m[1]!)) return "Hello";
  if (/^he/.test(m[1]!) || m[1] === "howdy") return "Hey";
  if (m[1] === "vanakkam") return "Vanakkam";
  if (/^namas/.test(m[1]!)) return "Namaste";
  return "Hi";
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** LB-28: "Hi! Shruti here." (a name right after a greeting, followed by "here"). */
function hereName(raw: string): string | null {
  const m = /^\W*(?:hi+|hello+|helo|hey+|hai|hiya|heya|howdy|vanakkam|namaste|namaskaram|namaskar|greetings|good\s+(?:morning|afternoon|evening|day))(?:\s+(?:there|all|everyone|team|sir|madam))?\W+([A-Za-z][A-Za-z'-]+)\s+here\b/i.exec(raw);
  if (!m) return null;
  const w = m[1]!.toLowerCase();
  if (NOT_INTRO_NAME.has(w) || NOT_NAME_WORDS.has(w) || FILLER_REPLY.test(w) || /ing$/.test(w) || NAME_BLOCK.test(w) || findPlace(w) || strainWordsIn(w).length) return null;
  return titleCase(w);
}
type Social = { greet: string | null; name: string | null; keeper: boolean; howAreYou: boolean; restRaw: string };
const HOW_ARE_YOU = /\b(?:how\s+(?:is|'s)\s+it\s+going|how'?s\s+it\s+going|how\s+are\s+(?:you|u)(?:\s+doing)?(?:\s+today)?|how\s+have\s+you\s+been|hope\s+(?:you(?:'re|\s+are)\s+)?(?:doing\s+)?(?:well|good|fine))\b/gi;
/**
 * LB-28: the social part of a message: a greeting WITH an intro, or "I love / keep discus".
 * Null when there is none (or the whole message is a plain pleasantry: LB-13 handles that).
 * Only this message's typed name is used (LB-24).
 */
function socialPreamble(raw: string, t: string): Social | null {
  const greeted = /\b(hi+|hello+|helo|hey+|hai|hiya|heya|howdy|vanakkam|namaste|namaskaram|namaskar|good\s+(morning|afternoon|evening|day)|greetings)\b/.test(t);
  const name = introName(raw) ?? (greeted ? hereName(raw) : null);
  KEEPER_RE.lastIndex = 0;
  const keeper = KEEPER_RE.test(raw);
  if (!keeper && !(greeted && name)) return null;
  if (pleasantryOnly(t) !== null) return null;
  HOW_ARE_YOU.lastIndex = 0;
  const howAreYou = HOW_ARE_YOU.test(raw);
  let rest = raw.replace(GREET_WORD, " ").replace(KEEPER_RE, " ").replace(HOW_ARE_YOU, " ");
  if (name) {
    const n = escapeRe(name).replace(/\s+/g, "\\s+");
    rest = rest
      // "I am Arjun from Bangalore" -> "I am from Bangalore" (keeps the self-location for delivery).
      .replace(new RegExp(`\\b(?:my\\s+name\\s+is|i\\s+am|i'm|i’m|im|this\\s+is)\\s+${n}(?=\\s*,?\\s+(?:from|in|at|based)\\b)`, "gi"), "I am")
      .replace(new RegExp(`\\b(?:my\\s+name\\s+is|my\\s+name's|name\\s+is|myself|call\\s+me|i\\s+am|i'm|i’m|im|this\\s+is)\\s+${n}\\b`, "gi"), " ")
      .replace(new RegExp(`\\b${n}\\s+here\\b`, "gi"), " ");
  }
  // Leftover joiners ("and am planning to buy" -> "planning to buy").
  rest = rest
    .replace(/(^|[.,!?;:\-–—]\s*)(?:and|so|also|&)\s+(?:i\s+am\s+|i'm\s+|am\s+)?/gi, "$1")
    .replace(/(^|[.,!?;:\-–—]\s*)(?:i\s+am|i'm|am)\s+(?=(?:plan|look|think|keen|interest|hop|go|want|wanting|ready|eager))/gi, "$1")
    .replace(/^[\s\W]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return { greet: greeted ? greetEcho(t) : null, name, keeper, howAreYou, restRaw: rest };
}
/** LB-28: the warm reply when the social part is all there is (or the rest matched nothing). */
function greetIntroReply(state: ChatState, s: Social): Turn {
  state.pendingOffer = null;
  const warm = ANSWERS.greetIntro(s.greet ?? "Hi", s.name, s.keeper, nextRot(state, "greet"), s.howAreYou);
  const intent = s.name ? "name_given" : "welcome";
  const known = state.askedLookingFor || state.lookingForHint || state.lead.lookingFor || state.handoff.active || state.completed || Boolean(state.lead.phone) || (state.contactAsk?.count ?? 0) > 0;
  if (known) return { reply: `${warm} ${ANSWERS.greetIntroHelp}`, intent };
  state.askedLookingFor = true;
  state.pendingOffer = "lookingFor";
  return { reply: `${warm} ${ANSWERS.greetIntroWelcome} ${ANSWERS.handoffAskLookingFor}`, intent };
}
/** Intents that mean "nothing real was answered": the warm greeting replaces them. */
const SOCIAL_FALLBACK = new Set(["unclear", "welcome", "welcome_new", "name_given", "small_talk", "off_topic", "thanks", "ack", "looking_for"]);
/** LB-28: route a message with a social preamble: answer the rest, greet warmly by name first. */
async function routeSocial(state: ChatState, raw: string, t: string, ctx: Ctx): Promise<Turn> {
  const s = socialPreamble(raw, t);
  if (!s) return routeIntent(state, raw, t, ctx);
  if (s.name && !state.lead.name) state.lead.name = s.name; // "Hi! Shruti here." (typed in this chat)
  const restT = norm(s.restRaw);
  if (!restT.replace(/[^a-z0-9]+/g, "")) return greetIntroReply(state, s);
  let turn = await routeIntent(state, s.restRaw, restT, ctx);
  // The rest alone matched nothing real: try the whole message once before the warm reply.
  if (SOCIAL_FALLBACK.has(turn.intent)) turn = await routeIntent(state, raw, t, ctx);
  if (SOCIAL_FALLBACK.has(turn.intent)) return greetIntroReply(state, s);
  const warm = ANSWERS.greetIntro(s.greet ?? "Hi", s.name, s.keeper, nextRot(state, "greet"), s.howAreYou);
  return { ...turn, reply: `${warm}\n\n${turn.reply}` };
}

/** LB-13: the answer to the fish-or-food question asked after a pleasantry. */
function lookingForAnswer(t: string): string | null {
  if (t.split(" ").length > 6 || /\?/.test(t)) return null;
  const v = parseLookingFor(t);
  return v && (lookingForPointer(v) || v === "not sure") ? v : null;
}

/** LB-6 B3: "can I order on chat itself?" -> No, orders go through the site. */
const ORDER_IN_CHAT =
  /\b(order|buy|book|purchase|reserve)\s+(it\s+|them\s+|fish\s+)?(on|in|through|via|over|using|from)\s+(the\s+|this\s+)?(chat|chatbot|bot|whatsapp|here)\b|\b(can|could|may|do)\s+(i|we)\s+(just\s+)?(order|buy|book|purchase)\s+(here|right\s+here|now\s+here|from\s+you\s+here)\b|\b(can|could|will)\s+(you|u)\s+(take|book|place|note)\s+(my|the|an|our)\s+order\b|\b(take|book|place)\s+(my|the|an)\s+order\s+(here|on\s+chat|in\s+chat|via\s+chat)\b|\bchat\s+(itself|la\s+order|mein\s+order)\b|\bchat\s+(la|le|mein|me)\s+(order|book)\w*/;
/** LB-6 B6: "how will I know you got my order?" -> Place request notifies Shiva, who contacts you. */
const ORDER_RECEIVED =
  /\bhow\s+(will|would|do|can|shall)\s+i\s+know\b[^?.]*\b(order|request|got\s+it|received|placed|went\s+through)\b|\b(did|have|has)\s+(you|u|shiva|the\s+den)\s+(get|got|receive|received|seen?)\s+(my|our|the)\s+(order|request)\b|\b(will|do)\s+(i|we)\s+get\s+(a\s+|any\s+)?(confirmation|notification|reply|call\s+back|message)\b|\bwhat\s+happens\s+(after|once|when)\s+(i\s+)?(place|order|placing|tap|submit)\w*|\b(order|request)\s+(confirmation|status|received)\b|\b(is|was)\s+my\s+(order|request)\s+(received|placed|confirmed|through)\b|\bwho\s+(will\s+)?(contact|call|reply\s+to)\s+me\b|\bwhen\s+(will|would|does|do)\s+(shiva|he|you|someone|the\s+den)\s+(contact|call|reply\s+to|message|get\s+back\s+to)\s+(me|us)\b|\bwhen\s+(will|do)\s+i\s+hear\s+(from|back)\b|\b(order|request)\s+(will\s+)?(reach|reaches|get\s+to|go\s+to)\s+(shiva|him|you)\b/;
/** LB-6 C7: collecting at the railway station is SOP step 4, not Chennai store pickup. */
const STATION = /\b(railway|station|platform|rail\s+agent|train\s+agent|porter|ported)\b/;
/** LB-6 C5: full amount / advance questions -> the SOP payment step. */
const PAY_SPLIT =
  /\b(full\s+(amount|payment|money)|pay\s+(it\s+)?all|whole\s+amount|entire\s+amount|advance|half|upfront|up\s+front|in\s+full|balance|instal+ments?|pay\s+(first|before|later|after|on\s+delivery)|before\s+(dispatch|shipping)|token\s+amount|part\s+payment)\b/;
/** LB-6 D1: light small talk. */
const SMALL_TALK =
  /\b(just\s+(chatting|browsing|bored|checking\s+(in|you\s+out))|favou?rite\s+(fish|discus|strain|colou?r|one)|how\s+are\s+(you|u)|how'?s\s+it\s+going|what'?s\s+up|wassup|lol|lmao|haha+|bored|time\s?pass|who\s+made\s+you|do\s+you\s+like\s+(fish|discus))\b/;
const FIRST_TIMER =
  /\b(first[\s-]?time(r)?\s+(buyer|buying|customer|order|ordering|here|purchase|with\s+you)|my\s+first\s+(order|purchase|time)|first\s+order|i'?m\s+(a\s+)?first[\s-]?timer|i'?m\s+new\s+to\s+(ordering|buying)|never\s+(bought|ordered)\s+(from|here|before)|new\s+customer|how\s+does\s+(it|this|the\s+(process|order\w*))\s+work|what\s+(is|'s)\s+the\s+process)\b/;
/** "Keep the fish longer" asks: only these get the 7-days-free / ₹100-a-day line. */
const KEEP_LONGER =
  /\b(longer|later|more\s+days|extra\s+days|few\s+(more\s+)?(days|weeks)|until|till|for\s+a\s+(week|while|few)|tank\s+(is\s+)?(not|isn'?t)\s+ready|not\s+ready\s+yet|keep\s+them\s+for|hold\s+(them|it|my\s+fish)\s+for)\b/;

const QUARANTINE_HOLD =
  /\b(quarantin\w*|hold|holds|holding|held|keep\s+(my|the)\s+fish|keep\s+them|keeps?\s+(the\s+)?fish|settle\w*|condition\w*\s+(the\s+)?fish)\b/;
const SHIP_WORD =
  /\b(ship|ships|shipped|shipping|send|sends|sent|deliver|delivers|delivered|delivery|courier\w*|dispatch\w*|parcel|post\s+it|anuppu\w*)\b/;

/** Generic "abroad" words name no place; show "Your location" instead. */
const GENERIC_PLACE = /^(abroad|overseas|outside india|out of india|international|internationally|foreign|outside the country|other countries|another country)$/;
const UPPER_PLACE: Record<string, string> = { uae: "UAE", usa: "USA", uk: "UK" };
/** LB-6 (Shiva, 3 Oct): outside the 8 train states -> care-first, tentative handoff offer. Never a refusal. */
function outOfArea(state: ChatState, place: Place): string {
  const name = GENERIC_PLACE.test(place.name) ? undefined : UPPER_PLACE[place.name] ?? titleCase(place.name);
  // LB-7 follow-up: the alert goes out once name + number are in, so keep the place the
  // visitor already named for the email (and don't ask for the city again).
  if (name) {
    state.lead.city ??= name;
    state.lead.inShipStates = false;
  }
  return outOfAreaReply(name, place.zone === "abroad");
}

/**
 * LB-18 (Shiva, 3 Oct): delivery-timing asks ("when will the fish reach me?", "how many
 * days to Bangalore?", "eppo varum?", "kab tak milega?"). Not "when will it ship?" (C4,
 * dispatch day) and not hold / quarantine-length questions.
 */
const DELIVERY_TIMING = new RegExp(
  [
    String.raw`\b(when|by\s+when|how\s+soon|how\s+long|how\s+many\s+(days|hours)|how\s+fast|what\s+day|which\s+day)\b[^?.!]*\b(reach|reaches|reached|arrive|arrives|arrival|delivered|receive|get\s+(my|the|them|it|those|these)\b|come\s+to\s+me|take\s+to\s+(reach|arrive|come|get)|delivery\s+take|shipping\s+take|transit|journey|by\s+train|on\s+the\s+train)`,
    String.raw`\b(how\s+many\s+days|how\s+long|how\s+soon|how\s+fast)\s+(for|4|is|does|will)?\s*(the\s+)?(delivery|shipping|transit)\b`,
    String.raw`\b(delivery|shipping|transit|arrival|travel)\s+(time|timing|timings|duration|date|days|period|eta)\b|\bestimated\s+(delivery|arrival)\b|\beta\b|\bhow\s+fast\s+is\s+(the\s+)?(shipping|delivery)\b`,
    // Tanglish: eppo varum / epo kedaikkum / evlo naal aagum / ethana naal la varum
    String.raw`\b(eppo|eppa|epo|yeppo|eppodhu|eppothu)\b[^?.!]*\b(varum|varuma|varumaa|kedaikkum|kidaikkum|kedaikum|serum|reach|delivery|vandhu\s+serum)\b|\b(varum|kedaikkum|kidaikkum|serum)\s+(eppo|epo|eppa)\b|\b(evlo|evvalavu|evlavu|evalo|ethana|ethanai|ethanai)\s+(naal|nal|naalu|days|day)\b|\bdelivery\s+(eppo|epo)\b`,
    // Hinglish: kab tak milega / kitne din mein aayega / delivery kab hogi
    String.raw`\bkab\s+(tak\s+)?(milega|milegi|milenge|aayega|aayegi|aaega|ayega|aayenge|pahunchega|pahunchegi|pahuchega|aa\s+jayega|aa\s+jaega|deliver)\b|\b(milega|milegi|aayega|ayega|pahunchega)\s+kab\b|\b(kitne|kitna|ketne)\s+(din|dino|time|samay|ghante)\b|\bdelivery\s+kab\b`,
  ].join("|"),
);
/** "how many days to Bangalore?" / "how long to Mumbai by train?" (only with a known place). */
const TIMING_TO_PLACE = /\bhow\s+(long|many\s+days?|many\s+hours)\s+((does|will)\s+it\s+take\s+)?(to|for|till|until)\s+/;
/**
 * LB-18 (Kiara 387ccb5): "how many days to <anything>" is a timing ask even when the place is
 * unknown or misspelt ("to banglore", "to some small town"), unless what follows "to" is an
 * action ("how long to acclimate / feed / wait").
 */
const TIMING_TO_ACTION =
  /\bhow\s+(long|many\s+days?|many\s+hours)\s+((does|will)\s+it\s+take\s+)?(to|for|till|until)\s+(acclimat\w*|feed\w*|wait\w*|keep\w*|cycle|cycling|settle|set|setup|change|cook|thaw|defrost|pay|reply|respond|answer|confirm|process|prepare|hold|fast|grow|breed|recover|heal|treat|quarantin\w*|get\s+(a\s+)?(reply|response|answer|confirmation)|hear|see|show|colou?r|eat|adjust|adapt|float|mature|spawn|clean|fill|start|finish|decide|book|order|place)\b/;
/** "hw mny dayz?" / "how long will it take?" with nothing else. */
const TIMING_BARE = /^(so\s+|and\s+|ok\s+)?how\s+(many\s+days?|long\s+(will|does)\s+it\s+take)\s*\??$/;
// LB-18 typos (Kiara 25a82a7): "wen will fish reach me", "delivry time", "hw long shiping",
// "fish reach when?", "when fish come". Word-order variants on the normalised text.
const TIMING_ORDER =
  /\b(reach|reaches|arrive|arrives|come|comes|delivery|delivered|get\s+(it|them|my\s+fish|the\s+fish))\s+(when|by\s+when)\b|\bwhen\b[^?.!]*\b(fish|it|they|order|parcel|discus|fishes)\s+(will\s+)?(come|reach|arrive|get\s+here)\b|\bhow\s+many\s+days?\s+(will\s+it\s+|to\s+)?(reach|arrive|come|delivery)\b/;
/** SMS short forms and common misspellings of the timing words (explicit: short words are never fuzzy-matched). */
const TIMING_SHORT: Record<string, string> = {
  wen: "when", whn: "when", wn: "when", wehn: "when", whne: "when", whan: "when",
  tym: "time", tme: "time", tim: "time", tyme: "time", timee: "time",
  hw: "how", hww: "how", hoow: "how",
  mny: "many", meny: "many", mani: "many", manny: "many", mnay: "many",
  dys: "days", dayz: "days", dyas: "days", d8s: "days", daays: "days", dais: "days", dayss: "days",
  lng: "long", lnog: "long", lomg: "long", lon: "long", longg: "long",
  dlvry: "delivery", dlvy: "delivery", dlivery: "delivery", delvry: "delivery", dilivery: "delivery", delevery: "delivery", delivry: "delivery",
  shpng: "shipping", shpg: "shipping", shippin: "shipping", shiping: "shipping", shippng: "shipping",
  rch: "reach", rech: "reach", reech: "reach", raech: "reach", reah: "reach",
  arive: "arrive", arrve: "arrive", ariv: "arrive", arival: "arrival",
  cum: "come", kum: "come", cme: "come", coem: "come",
  wil: "will", wll: "will", wiil: "will",
  gt: "get", gte: "get",
};
const TIMING_LONG = ["delivery", "shipping", "arrive", "arrival", "reach"];
/** Words that look like a timing word but aren't ("shopping bag", "deliver" is fine as is). */
const TIMING_NOT = new Set(["shopping", "shipped", "react", "teach", "delicious", "deliver", "delivers", "delivered", "arrived", "reached"]);
function timingWord(w: string): string {
  if (TIMING_SHORT[w]) return TIMING_SHORT[w]!;
  if (w.length < 5 || TIMING_NOT.has(w)) return w;
  for (const v of TIMING_LONG) {
    if (w[0] !== v[0] || w === v) continue;
    const limit = v.length >= 8 ? 2 : 1;
    if (levenshtein(squeeze(w), v) <= limit || levenshtein(w, v) <= limit) return v;
  }
  return w;
}
/** Plain Levenshtein distance (uncapped; editDistance above returns 2 for "2 or more"). */
function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}
/** LB-18: the message with timing-vocabulary typos and short forms mapped to the real words. */
export function timingNorm(t: string): string {
  return t.replace(/[a-z0-9]+/g, (w) => timingWord(w));
}

const NOT_TIMING = /\b(days?\s+old|weeks?\s+old|(get|hear)\s+(a\s+|any\s+|back\s+)?(reply|response|answer)|back\s+in\s+stock|in\s+stock|restock\w*|come\s+back|available\s+again|new\s+(fish|stock|batch|arrivals?|strains?)|next\s+(batch|lot|stock)|when\s+did|acclimat\w*|(should|do|can)\s+i\s+(switch|turn|feed|keep|add|put|float|open|change)|hold|holding|keep\s+(them|my\s+fish|the\s+fish)|quarantin\w*|fast(ed|ing)?\s+(them|the\s+fish|for)|grow|live|lifespan|refund|claim)\b|\bwhen\s+(will|do|would|does)\s+(you|it|they|the\s+fish)\s+(ship|dispatch|send)\b(?![^?.!]*\b(reach|arrive|get\s+to)\b)/;

/** LB-18 broad fallback: a typo-tolerant delivery / deliver / days / reach / ship / arrive / "how long" word. */
const DELIVERY_ISH =
  /\b(delivery|deliveries|deliver|delivers|delivered|delivering|days?|reach|reaches|ship|ships|shipping|shipment|arrive|arrives|arrival|courier|parcel|transit|how\s+long|eta|kab\s+tak|kitne\s+din|eppo\s+varum|evlo\s+naal|ethana\s+naal)\b/;
export function isDeliveryIsh(t: string): boolean {
  const n = timingNorm(t);
  return DELIVERY_ISH.test(n) && !NOT_TIMING.test(n);
}

function deliveryTimingAnswer(state: ChatState, t: string): Turn {
  state.pendingOffer = null;
  // LB-18: a misspelt known city ("banglore", "kolkatta") counts; an unknown place gets the general reply.
  const place = findPlace(t) ?? findPlaceFuzzy(t);
  if (place && CHENNAI.test(place.name)) {
    state.lead.stateName ??= place.state;
    return { reply: ANSWERS.deliveryTimingChennai, intent: "delivery_timing_chennai" };
  }
  if (place && place.zone !== "in") return shippingAnswer(state, t, { place }); // LB-6 care-first handoff (never a refusal)
  if (place) state.lead.stateName ??= place.state;
  const lead = place && !/^(tamil nadu|tamilnadu|kerala|karnataka|andhra pradesh|telangana|maharashtra|madhya pradesh|odisha|orissa)$/.test(place.name)
    ? deliveryTimingFor(titleCase(place.name))
    : ANSWERS.deliveryTiming;
  return { reply: join(lead, SOP_BLOCK, ANSWERS.deliveryTimingPickup), intent: place ? "delivery_timing_place" : "delivery_timing" };
}

function shippingAnswer(state: ChatState, t: string, opts: { sop?: boolean; place?: Place } = {}): Turn {
  const withSop = (opts.sop ?? true) && !CHENNAI.test(t);
  // LB-18: misspelt places too ("do you ship to kolkatta" -> the care-first handoff).
  const place = opts.place ?? findPlace(t) ?? findPlaceFuzzy(t);
  if (place) {
    state.lead.stateName ??= place.state;
    if (place.zone === "in") {
      state.pendingOffer = null;
      // LB-6: in-state, non-Chennai -> the SOP for how it works.
      return { reply: withSop ? join(ANSWERS.shipInStates, SOP_BLOCK) : ANSWERS.shipInStates, intent: "ship_in_states" };
    }
    addFlag(state, "OUTSIDE 8 STATES");
    state.pendingOffer = "handoff";
    if (place.zone === "other") return { reply: outOfArea(state, place), intent: "ship_other_state" };
    addFlag(state, "REMOTE");
    if (place.zone === "remote") return { reply: outOfArea(state, place), intent: "ship_remote" };
    return { reply: outOfArea(state, place), intent: "ship_abroad" };
  }
  state.pendingOffer = null;
  return { reply: withSop ? join(ANSWERS.shipInStates, SOP_BLOCK) : ANSWERS.shipInStates, intent: "ship_general" };
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

type Msg = { state: ChatState; raw: string; t: string; ctx: Ctx; offTopic: boolean; lookingForPending?: boolean };
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
  applyHandoffKind(state, "claim"); // LB-11: a loss / DOA claim isn't a fish-or-food purchase
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
  if (place.zone === "other") return { reply: outOfArea(state, place), intent: "guarantee_other_state" };
  addFlag(state, "REMOTE");
  if (place.zone === "remote") return { reply: outOfArea(state, place), intent: "guarantee_remote" };
  return { reply: outOfArea(state, place), intent: "guarantee_abroad" };
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
    run: ({ state, raw }) => { addFlag(state, "DOA CLAIM"); return startHandoff(state, raw, ANSWERS.doa, "claim"); },
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
    // LB-6 B6: "did you get my order?" is about the request, not a payment.
    test: (m) => isPaymentDetails(m.t, m.raw) && !(ORDER_RECEIVED.test(m.t) && !RE.payment.test(m.t)),
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
      // LB-6 (Shiva, 3 Oct): no handoff; volume discounts are automatic in the Shopping Bag. Never a code.
      addFlag(state, "DISCOUNT ASKED");
      state.pendingOffer = null;
      return { reply: join(ANSWERS.discount, SITE_STEPS), intent: "discount" };
    },
  },
  {
    id: "doa_refund", tier: "safety", faq: "FAQ 10 (report)",
    test: (m) => RE.doaReport.test(m.t),
    run: ({ state, raw }) => { addFlag(state, "DOA CLAIM"); return startHandoff(state, raw, ANSWERS.doa, "claim"); },
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
    test: (m) => RE.stock.test(m.t) || QTY_ASK.test(m.t),
    run: ({ state, raw, t, ctx }) => stockAnswer(state, raw, t, ctx),
  },
  {
    // LB-1: the owner's name as printed on the site. Never a phone/GPay number.
    id: "owner", tier: "safety", faq: "B12: owner name from site",
    test: (m) => RE.owner.test(m.t),
    run: ({ state, ctx }) => ownerAnswer(state, ctx),
  },
  {
    // LB-24 (Shiva, 8 Oct, privacy): "what is my phone number / name / details?" -> never shows
    // anything saved (a shared device may be someone else); invites them to type it.
    id: "privacy_details", tier: "safety", faq: "LB-24: no saved details shown",
    test: (m) => PRIVACY_ASK.test(m.t),
    run: ({ state }) => {
      state.pendingOffer = null;
      if (state.lead.phone) return { reply: ANSWERS.privacyHasDetails(nextRot(state, "privacy")), intent: "privacy_details" };
      contactAsk(state).pending = true;
      return { reply: ANSWERS.privacyNoDetails(nextRot(state, "privacy")), intent: "privacy_details" };
    },
  },
  {
    id: "are_you_human", tier: "safety", faq: "Rules: are you a person",
    test: (m) => RE.human.test(m.t),
    // LB-6 A4: "is this a bot? I want a real person" -> who we are + the site steer.
    run: ({ state }) => {
      state.pendingOffer = null;
      // LB-19: plus the name + WhatsApp ask (or the LB-15 line after a decline).
      const push = contactOrPush(state);
      return { reply: `${ANSWERS.areYouHuman} ${push.reply}`, intent: "are_you_human" };
    },
  },
  {
    // LB-6 (Shiva, 3 Oct): pushes to reach a human / Shiva are steered to the
    // site (order via the Shopping Bag; Shiva is notified on Place request).
    // No handoff, no name/number collection; repeats get a shorter steer.
    id: "talk_to_shiva", tier: "safety", faq: "LB-6: steer to site",
    // LB-14: plus connect / reach / contact / "put me through" / "get me the owner" (typos too).
    // "can I call to visit the store" (no person named) stays on the visit answer.
    // LB-18: "when will Shiva contact me?" (after ordering) is B6, not a push.
    test: (m) => (RE.talkToShiva.test(m.t) || HUMAN_PUSH.test(m.t) || isReachAsk(m.t)) && !(RE.visit.test(m.t) && !PERSON_WORD.test(m.t)) && !ORDER_RECEIVED.test(m.t),
    run: ({ state }) => {
      state.pendingOffer = null;
      // LB-19: no number yet -> the name + WhatsApp ask (was the LB-14 self-explanatory line).
      // LB-15's polite, rotated line still applies once the number was declined / both asks used.
      return contactOrPush(state);
    },
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

  {
    // LB-13: answer to "Discus fish or Discus frozen foods?" asked after a pleasantry.
    id: "looking_for_answer", tier: "offer", faq: "LB-13: fish or food",
    test: (m) => m.lookingForPending === true && lookingForAnswer(m.t) !== null,
    run: ({ state, t }) => {
      const v = lookingForAnswer(t)!;
      state.lookingForHint = v;
      state.pendingOffer = null;
      return { reply: lookingForPointer(v) ?? ANSWERS.lookingForBoth, intent: "looking_for" };
    },
  },

  // ---- 3. FAQs ----
  {
    // LB-13: greetings, thanks, bye and "I'm new" on their own (first-timer order questions keep the SOP).
    id: "pleasantry", tier: "faq", faq: "LB-13: pleasantry",
    test: (m) => pleasantryOnly(m.t) !== null && !FIRST_TIMER.test(m.t),
    run: ({ state, t }) => pleasantryReply(state, pleasantryOnly(t)!),
  },
  {
    // LB-6 B3 (Lea, 3 Oct): orders never happen in the chat.
    id: "order_in_chat", tier: "faq", faq: "LB-6: order via site",
    test: (m) => ORDER_IN_CHAT.test(m.t),
    run: ({ state }) => { state.pendingOffer = null; return { reply: ANSWERS.orderInChat, intent: "order_in_chat" }; },
  },
  {
    // LB-6 B6: confirmation = "Request placed" on the site; Shiva is notified and contacts the customer.
    id: "order_received", tier: "faq", faq: "LB-6: request placed",
    test: (m) => ORDER_RECEIVED.test(m.t),
    run: ({ state }) => { state.pendingOffer = null; return { reply: ANSWERS.orderReceived, intent: "order_received" }; },
  },
  {
    // LB-18: "when will the fish reach me?" -> depends on place + train route, then the SOP + Chennai pickup.
    id: "delivery_timing", tier: "faq", faq: "LB-18: delivery timing",
    // LB-18 typos: matched on timingNorm(t) ("wen", "delivry", "hw lng", "tym"...).
    test: (m) => {
      const n = timingNorm(m.t);
      return (DELIVERY_TIMING.test(n) || TIMING_ORDER.test(n) || TIMING_BARE.test(n) || (TIMING_TO_PLACE.test(n) && !TIMING_TO_ACTION.test(n))) && !NOT_TIMING.test(n);
    },
    run: ({ state, t }) => deliveryTimingAnswer(state, t),
  },
  {
    // LB-6 C5: "full amount first?" -> half advance at the holding tank, balance on shipping day.
    id: "pay_advance", tier: "faq", faq: "LB-6: SOP step 5",
    test: (m) => PAY_SPLIT.test(m.t) && !RE.shipCost.test(m.t) && !RE.holding.test(m.t) && (RE.payment.test(m.t) || /\b(amount|money|full|whole)\b/.test(m.t)),
    run: ({ state }) => { state.pendingOffer = null; return { reply: ANSWERS.payAdvance, intent: "pay_advance" }; },
  },
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
    // LB-5: a size / age / cheaper option / batch / custom request that isn't
    // listed -> firm "the stock page is everything" reply. Runs after safety and
    // before holding, price and strain rules. Returns null (falls through) when
    // the requested size exactly matches a listed card.
    id: "unlisted_firm", tier: "faq", faq: "LB-5: unlisted request (firm)",
    test: (m) => unlistedAsk(m.t) !== null,
    run: ({ state, raw, t, ctx }) => unlistedFirm(state, raw, t, ctx),
  },
  {
    // LB-3: quarantine / hold / keep-the-fish + shipping in one message ->
    // "Yes." + quarantine (FAQ 13) + hold rule (FAQ 14) + delivery (FAQ 5/25),
    // ahead of the plain holding and delivery-states answers.
    id: "quarantine_ship", tier: "faq", faq: "LB-3: FAQ 13 + 14 + 5",
    test: (m) => QUARANTINE_HOLD.test(m.t) && SHIP_WORD.test(m.t),
    run: ({ state, t }) => {
      // LB-6: the SOP is the normal flow; the 7-days-free line only when the
      // customer asks us to keep the fish longer.
      const delivery = shippingAnswer(state, t, { sop: false });
      const parts: string[] = [`${ANSWERS.quarantineShipYes} ${ANSWERS.quarantine}`];
      if (KEEP_LONGER.test(t) || RE.holdingBeyond.test(t)) {
        let hold: string = ANSWERS.holding;
        if (RE.holdingBeyond.test(t)) {
          addFlag(state, "LONG HOLD");
          hold = `${ANSWERS.holding} ${ANSWERS.holdingBeyond}`;
          state.pendingOffer = "handoff";
        }
        parts[0] += ` ${hold}`;
      }
      const outside = delivery.intent !== "ship_in_states" && delivery.intent !== "ship_general";
      if (!outside && !CHENNAI.test(t)) parts.push(SOP_BLOCK);
      parts.push(delivery.reply);
      return { reply: join(...parts), intent: "quarantine_ship" };
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
    // LB-11: "should I buy a pair?" -> prices are per piece, choose the quantity on the card (+ steps).
    id: "how_many_to_buy", tier: "faq", faq: "FAQ 4",
    test: (m) => RE.pairSingle.test(m.t),
    run: ({ state }) => { state.pendingOffer = null; return { reply: join(ANSWERS.howManyToBuy, SITE_STEPS), intent: "how_many_to_buy" }; },
  },
  {
    id: "per_piece", tier: "faq", faq: "FAQ 2 (per piece)",
    test: (m) => RE.perPiece.test(m.t) && !matchAny(m.raw),
    run: ({ state }) => { state.pendingOffer = null; return { reply: `${PER_PIECE_LINE} ${VOLUME_DISCOUNT_LINE}`, intent: "per_piece" }; },
  },
  {
    // LB-6: first-time customers get the order steer + SOP.
    id: "first_timer", tier: "faq", faq: "LB-6: SOP",
    test: (m) => FIRST_TIMER.test(m.t),
    run: ({ state }) => {
      state.pendingOffer = null;
      state.tags.history ??= "first-timer";
      return { reply: join(ANSWERS.ordering, SOP_BLOCK), intent: "first_timer" };
    },
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
    // LB-6 C7: "can I pick up from the station?" -> SOP step 4 (railway agent) + the SOP.
    id: "station_pickup", tier: "faq", faq: "LB-6: SOP step 4",
    test: (m) => STATION.test(m.t) && !/\b(fire|police|bus)\s+station\b/.test(m.t),
    run: ({ state }) => { state.pendingOffer = null; state.lead.delivery ??= "train shipping"; return { reply: join(ANSWERS.stationPickup, SOP_BLOCK), intent: "station_pickup" }; },
  },
  {
    id: "pickup", tier: "faq", faq: "FAQ 12",
    test: (m) => RE.pickup.test(m.t),
    run: ({ state }) => { state.lead.delivery ??= "Chennai pickup"; state.pendingOffer = "handoff"; return { reply: ANSWERS.pickup, intent: "pickup" }; },
  },
  {
    id: "ship_how", tier: "faq", faq: "FAQ 9",
    test: (m) => RE.shipHow.test(timingNorm(m.t)) && !findPlace(m.t), // LB-18: "wen will it ship" too
    run: ({ state }) => { state.pendingOffer = null; return { reply: join(`${ANSWERS.shippingHow}\n${ANSWERS.sop}`, ANSWERS.shipInStates), intent: "ship_how" }; },
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
    run: ({ state }) => { state.pendingOffer = null; return { reply: join(ANSWERS.ordering, SOP_BLOCK), intent: "ordering" }; },
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
  // LB-28: "planning / looking / thinking of / keen to buy ..." is buy intent too (the window + ask, as "want to buy discus").
  // With a place named ("from Bangalore, looking to buy") the delivery reply (with the SOP) still answers, as before.
  { id: "available", tier: "faq", faq: "FAQ 1", test: (m) => RE.available.test(m.t) || (isBuyIntent(m.t) && !findPlace(m.t)), run: ({ state, raw, t, ctx }) => priceOrAvailability(state, raw, t, ctx, "available") },
  {
    id: "care_tips", tier: "faq", faq: "Quick tap: care tips",
    test: (m) => RE.care.test(m.t),
    run: ({ state }) => { state.pendingOffer = null; return { reply: ANSWERS.careTips, intent: "care_tips" }; }, // LB-6 D2
  },
  {
    // A strain, colour or size named on its own ("yellow diamonds?", "red ones", "any 5 inch?").
    id: "strain_named", tier: "faq", faq: "FAQ 2 / 20",
    test: (m) => strainWordsIn(m.t).length > 0 || sizeAskRe.test(m.t) || hasColour(m.t),
    run: ({ state, raw, t, ctx }) =>
      priceOrAvailability(state, raw, t, ctx, sizeAskRe.test(t) || COLOURS.some((c) => t.includes(c)) ? "available" : "strain"),
  },
  {
    // LB-19 (replaces LB-6 contact_typed_steer): a number typed anywhere is saved
    // (respond() already stored it, with a name if one came along) and acknowledged.
    // Name + number -> the closing message (the chat ends); number only -> ask the name.
    id: "contact_typed", tier: "faq", faq: "LB-19: contact saved",
    test: (m) => extractIndianMobile(m.raw) !== null,
    run: ({ state }) => {
      state.pendingOffer = null;
      return contactAck(state);
    },
  },
  {
    // LB-19 human check: digits that aren't a valid 10-digit Indian mobile -> recheck, never a Lead.
    id: "phone_invalid", tier: "faq", faq: "LB-19: recheck number",
    test: (m) => looksLikeBadNumber(m.raw),
    run: ({ state }) => {
      state.pendingOffer = null;
      state.badNumbers = (state.badNumbers ?? 0) + 1;
      if (!state.flags.includes("INVALID NUMBER TYPED" as LeadFlag)) state.flags.push("INVALID NUMBER TYPED" as LeadFlag);
      contactAsk(state).pending = true;
      return { reply: ANSWERS.phoneInvalid, intent: "phone_invalid" };
    },
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
  {
    // LB-6 D1: chit-chat gets a warm redirect to the stock page.
    id: "small_talk", tier: "smalltalk", faq: "LB-6: small talk",
    test: (m) => SMALL_TALK.test(m.t),
    run: ({ state }) => { state.pendingOffer = null; return { reply: ANSWERS.smallTalk, intent: "small_talk" }; },
  },
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
    run: ({ state, t }) => {
      // LB-18 broad fallback (Kiara 987208a, Lea): anything delivery- or timing-ish that nothing
      // else matched gets the location + timing reply instead of "didn't catch that".
      if (isDeliveryIsh(t)) return deliveryTimingAnswer(state, t);
      state.pendingOffer = null;
      return { reply: ANSWERS.unclear, intent: "unclear" };
    },
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

/**
 * LB-11: per-path fish-or-food slot.
 * - claim: sick fish, mortality, refund-for-sure -> no fish-or-food question (DOA / loss net set it directly).
 * - fish: strain not listed, hold beyond 7 days, safe-arrival guarantee -> already about fish, not asked.
 * - everything else (visit, store pickup, reseller, outside the 8 states, claimed offer) -> asked.
 */
function handoffKindOf(intent: string): ChatState["handoffKind"] {
  if (/^(sick_fish|mortality|doa_policy|loss_safety_net)$/.test(intent)) return "claim";
  if (/^(strain_not_listed|holding_beyond|guarantee_)/.test(intent) || intent === "quarantine_ship") return "fish";
  return undefined;
}

/** Normal (non-handoff) routing: first matching rule in INTENT_RULES wins. */
async function routeIntent(state: ChatState, raw: string, t: string, ctx: Ctx): Promise<Turn> {
  const m: Msg = { state, raw, t, ctx, offTopic: isOffTopic(t), lookingForPending: state.pendingOffer === "lookingFor" };
  if (m.lookingForPending) state.pendingOffer = null;
  for (const rule of INTENT_RULES) {
    if (rule.tier === "faq" && m.offTopic) continue;
    if (!rule.test(m)) continue;
    const turn = await rule.run(m);
    if (turn) {
      // LB-11: remember what a handoff offer was about (read by startHandoff on "yes").
      state.handoffKind = state.pendingOffer === "handoff" ? handoffKindOf(turn.intent) : undefined;
      return turn;
    }
  }
  state.pendingOffer = null;
  state.handoffKind = undefined;
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

  // LB-11: a number typed at a later step ("9845012345" while asked fish-or-food) is
  // still the number: keep it and carry on, instead of treating it as a side question.
  if (!interrupt && !answered && step !== "name" && step !== "phone" && !state.lead.phone) {
    const phone = extractIndianMobile(raw);
    if (phone) {
      state.lead.phone = phone;
      return advance(state);
    }
  }

  // A question instead of an answer: answer it, then re-ask the same field.
  // Prompt attacks and other safety rules always take this path.
  if (interrupt || (!answered && !RE.declineField.test(t))) {
    const probe = newProbe(state);
    const r = await routeIntent(probe, raw, t, ctx);
    const generic = ["unsure", "unclear", "off_topic", "ack", "welcome", "welcome_new", "thanks", "looking_for"].includes(r.intent);
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
    if (raw.includes("?") && (step === "lookingFor" || step === "delivery" || step === "timeline")) {
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
    case "lookingFor": {
      const v = parseLookingFor(t);
      if (v) state.lead.lookingFor = v;
      else if (RE.declineField.test(t)) state.handoff.declined.push("lookingFor");
      else if ((state.handoff.lookingTries ?? 0) < 1) {
        state.handoff.lookingTries = (state.handoff.lookingTries ?? 0) + 1;
        return { reply: ANSWERS.handoffAskLookingFor, intent: "handoff_lookingFor_retry" };
      } else state.lead.lookingFor = raw.trim().slice(0, 60);
      // Fish -> Current Stock; frozen foods -> /frozen + /pellets; same Shopping Bag steps.
      return advance(state, lookingForPointer(state.lead.lookingFor));
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
  // LB-11: sessions saved mid-handoff before the change may still sit on the old pair/single step.
  if ((state.handoff.step as string | undefined) === "pairSingle") state.handoff.step = "lookingFor";
  state.handoff.declined = state.handoff.declined.map((s) => ((s as string) === "pairSingle" ? "lookingFor" : s));
  const raw = String(message ?? "").trim();
  const t = norm(raw);
  state.turns += 1;
  updateTags(state, t);

  const prevPhone = state.lead.phone;
  const turn = state.handoff.active ? await handoffTurn(state, raw, t, ctx) : await chatTurn(state, raw, t, ctx);
  const phoneCapturedNow = Boolean(state.lead.phone && state.lead.phone !== prevPhone);

  return {
    reply: turn.reply,
    handoff: state.handoff.active || Boolean(turn.completedNow),
    state,
    intent: turn.intent,
    completedNow: Boolean(turn.completedNow),
    phoneCapturedNow,
    closedNow: Boolean(turn.completedNow),
  };
}

/**
 * LB-19: one turn outside a handoff. Saves a number typed anywhere (plus a name
 * next to it), handles replies to the name + WhatsApp ask, routes the message,
 * then appends the ask after a real-interest answer.
 */
async function chatTurn(state: ChatState, raw: string, t: string, ctx: Ctx): Promise<Turn> {
  const a = state.contactAsk;
  const wasPending = Boolean(a?.pending);
  const awaitingName = Boolean(a?.awaitingName);
  if (a) {
    a.pending = false;
    a.awaitingName = false;
  }
  const short = t.split(" ").length <= 5;

  // LB-22: a volunteered name / city ("I am Arjun from Bangalore, looking to buy discus").
  const hadName = Boolean(state.lead.name);
  if (!hadName) {
    const intro = introName(raw);
    if (intro) state.lead.name = intro;
  }
  prefillCity(state, t);

  // A number typed anywhere is saved, whatever else the message says.
  const phone = extractIndianMobile(raw);
  let captured = false;
  if (phone && phone !== state.lead.phone) {
    state.lead.phone = phone;
    captured = true;
    const name = state.lead.name ? null : nameNearNumber(raw);
    if (name) state.lead.name = name;
    prefillFromMessage(state, raw, t);
  }

  if (!phone && awaitingName && safetyIntent(raw) === null) {
    // "Ravi" after "What name should he use?"
    // LB-22: a push ("real person please") or filler after the name ask is not a name.
    const name = short && !isPersonRequest(t) && !FILLER_REPLY.test(t) ? parseName(raw) : null;
    if (name && !strainWordsIn(t).length && !findPlace(t) && !name.toLowerCase().split(/\s+/).some((w) => NOT_NAME_WORDS.has(w) || NOT_INTRO_NAME.has(w))) {
      state.lead.name = name;
      return contactAck(state);
    }
  }
  const turn = await routeSocial(state, raw, t, ctx);

  // A plain "no" / "yes" to the ask (only when the message isn't a question of its own).
  const generic = ["unclear", "ack", "off_topic", "offer_declined", "small_talk", "thanks"].includes(turn.intent);
  // LB-22: "okay, thanks" after an ask is a plain thanks, not a "yes".
  const thanked = /\b(thanks?|thank\s*(you|u)|thanku|thx|ty)\b/.test(t);
  if (!phone && wasPending && short && generic) {
    if (RE.negate.test(t) || RE.declineField.test(t) || RE.cancel.test(t)) {
      contactAsk(state).declined = true;
      state.pendingOffer = null;
      // LB-25 / G5: repeated declines never get the same words twice (1st = handoffDeclined).
      return { reply: ANSWERS.askDeclined(nextRot(state, "decline")), intent: "contact_declined" };
    }
    if (RE.affirm.test(t) && !/\?/.test(raw) && !thanked) {
      contactAsk(state).pending = true;
      return { reply: ANSWERS.contactAskYes, intent: "contact_yes" };
    }
  }

  // Name alone after an ask ("Ravi"): nothing else matched, so it's the name.
  if (!phone && wasPending && !state.lead.name && (turn.intent === "unclear" || turn.intent === "off_topic") && t.split(" ").length <= 3 && !FILLER_REPLY.test(t)) {
    const name = parseName(raw);
    if (name && !strainWordsIn(t).length) {
      state.lead.name = name;
      contactAsk(state).pending = true;
      return { reply: ANSWERS.handoffAskPhone(name), intent: "contact_name" };
    }
  }
  // LB-22: a name typed after an ask ("I am Ravi") -> ask for the number by name.
  if (!phone && wasPending && !hadName && state.lead.name && !state.lead.phone && (turn.intent === "name_given" || turn.intent === "unclear")) {
    contactAsk(state).pending = true;
    return { reply: ANSWERS.humanAskPhone(state.lead.name, nextRot(state, "phone")), intent: "contact_name" };
  }
  if (captured && /^(human_push|are_you_human)/.test(turn.intent)) {
    // "connect me to Shiva, 98450 12345": the number is the answer to the push.
    return contactAck(state);
  }
  if (captured && turn.intent !== "contact_saved" && turn.intent !== "contact_saved_need_name" && !turn.completedNow) {
    // The number came with another question (or a safety message): answer first, then acknowledge.
    if (state.handoff.active) return turn;
    return { ...turn, reply: join(turn.reply, ANSWERS.contactNoted) };
  }
  return maybeAppendAsk(state, turn);
}
