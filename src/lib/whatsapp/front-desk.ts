/**
 * FE-2 WhatsApp front-desk bot — rules-first if-else (not LLM).
 * Spec: fe2-faq-qualification.md
 */

export type Outcome = "PASS" | "SOFT_FAIL" | "HARD_FAIL" | "ESCALATE" | "CONTINUE";

export type Step =
  | "greet"
  | "intent"
  | "location"
  | "experience"
  | "tank"
  | "seriousness"
  | "stock"
  | "closed"
  | "escalated";

export type ShipState = "TN" | "KL" | "KA" | "AP" | "TS";

export const SHIP_STATES: readonly ShipState[] = ["TN", "KL", "KA", "AP", "TS"];

export type FrontDeskSession = {
  waId: string;
  step: Step;
  shipState?: ShipState;
  experienceOk?: boolean;
  tankOk?: boolean;
  seriousnessOk?: boolean;
  softFailCount: number;
  /** Soft price-gate already offered; further price-refuse → HARD_FAIL (§4[B] / TC-04). */
  priceSoftOffered: boolean;
  offTopicCount: number;
  emptyNudgeCount: number;
  locationClarifyCount: number;
  cherryPickCount: number;
  gibberishCount: number;
  stockShared: boolean;
  closed: boolean;
  lastOutcome?: Outcome;
};

export type FrontDeskReply = {
  text: string;
  outcome: Outcome;
  session: FrontDeskSession;
};

const SITE = "https://thediscusden.com";

const CITY_TO_STATE: Record<string, ShipState> = {
  chennai: "TN",
  madurai: "TN",
  coimbatore: "TN",
  trichy: "TN",
  salem: "TN",
  kochi: "KL",
  cochin: "KL",
  trivandrum: "KL",
  thiruvananthapuram: "KL",
  kozhikode: "KL",
  calicut: "KL",
  bangalore: "KA",
  bengaluru: "KA",
  mysore: "KA",
  mysuru: "KA",
  mangalore: "KA",
  hyderabad: "TS",
  secunderabad: "TS",
  warangal: "TS",
  vizag: "AP",
  visakhapatnam: "AP",
  vijayawada: "AP",
  guntur: "AP",
  tirupati: "AP",
};

const STATE_ALIASES: Record<string, ShipState> = {
  tn: "TN",
  "tamil nadu": "TN",
  tamilnadu: "TN",
  kl: "KL",
  kerala: "KL",
  ka: "KA",
  karnataka: "KA",
  ap: "AP",
  "andhra pradesh": "AP",
  andhra: "AP",
  ts: "TS",
  telangana: "TS",
};

/** In-memory sessions keyed by WhatsApp waId (phone). */
const sessions = new Map<string, FrontDeskSession>();

export function resetSessions(): void {
  sessions.clear();
  resetBursts();
}

export function getSession(waId: string): FrontDeskSession {
  let s = sessions.get(waId);
  if (!s) {
    s = {
      waId,
      step: "greet",
      softFailCount: 0,
      priceSoftOffered: false,
      offTopicCount: 0,
      emptyNudgeCount: 0,
      locationClarifyCount: 0,
      cherryPickCount: 0,
      gibberishCount: 0,
      stockShared: false,
      closed: false,
    };
    sessions.set(waId, s);
  }
  return s;
}

export function setSession(session: FrontDeskSession): void {
  sessions.set(session.waId, session);
}

function clone(s: FrontDeskSession): FrontDeskSession {
  return { ...s };
}

function reply(
  session: FrontDeskSession,
  text: string,
  outcome: Outcome,
  patch: Partial<FrontDeskSession> = {},
): FrontDeskReply {
  const next: FrontDeskSession = {
    ...session,
    ...patch,
    lastOutcome: outcome,
  };
  if (outcome === "HARD_FAIL") {
    next.closed = true;
    next.step = "closed";
  }
  if (outcome === "ESCALATE" || outcome === "PASS") {
    next.step = "escalated";
    next.closed = true;
  }
  setSession(next);
  return { text, outcome, session: next };
}

function norm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isGreeting(t: string): boolean {
  return /^(hi|hello|hey|hii+|hola|namaste|vanakkam|good\s+(morning|afternoon|evening)|start|hiya)\b[!?.]*$/.test(
    t,
  );
}

function isEmptyOrStickerish(t: string): boolean {
  if (!t) return true;
  // emoji / punctuation only
  if (/^[\p{Emoji}\p{P}\s]+$/u.test(t) && !/[a-z0-9]/i.test(t)) return true;
  return false;
}

function looksGibberish(t: string): boolean {
  if (t.length < 2) return true;
  // keyboard smash: long run of consonants / repeated chars, few vowels
  const letters = t.replace(/[^a-z]/g, "");
  if (letters.length >= 6) {
    const vowels = (letters.match(/[aeiou]/g) || []).length;
    if (vowels / letters.length < 0.15) return true;
  }
  // mostly non-latin without clear English intent words
  const nonLatin = (t.match(/[^\x00-\x7F]/g) || []).length;
  if (nonLatin > t.length * 0.6 && !hasDenIntent(t)) return true;
  return false;
}

function hasDenIntent(t: string): boolean {
  return /\b(discus|fish|stock|ship|shipping|tank|strain|yellow\s*diamond|price|rate|cost|buy|order|enquiry|inquiry|availability|doa|delivery|heater|group|cycled|whatsapp|den)\b/i.test(
    t,
  );
}

function isOffTopic(t: string): boolean {
  if (hasDenIntent(t)) return false;
  return /\b(relationship|girlfriend|boyfriend|marriage|divorce|politics|election|vote|covid|fever|doctor|hospital|human\s+medical|joke|meme|crypto|bitcoin|loan|job\s+offer)\b/i.test(
    t,
  );
}

function isPriceOnly(t: string): boolean {
  return /\b(price|rate|cost|cheapest|rate\s*card|how\s*much|quote|₹|rs\.?)\b/i.test(t);
}

/** Explicit refuse to answer qualify questions (after soft price gate) — TC-04 / §4[B]. */
function isQualifyRefuse(t: string): boolean {
  return /\b(just\s+(give\s+)?(me\s+)?(the\s+)?price|only\s+(want\s+)?(the\s+)?price|price\s+only|don'?t\s+(want\s+to\s+)?(answer|share|give|say)|won'?t\s+(answer|share|say)|not\s+(telling|sharing)|skip\s+(the\s+)?(questions?|qualify)|no\s+(state|location|details)|refuse)\b/i.test(
    t,
  );
}

function isVipOrEscalateIntent(t: string): boolean {
  return /\b(vip|bulk|club|reseller|wholesale|media|complaint|prior\s+order|last\s+order|issue|hold\s+these|farm\s+visit|visit\s+the\s+farm|pickup)\b/i.test(
    t,
  );
}

function isAbuse(t: string): boolean {
  return /\b(fuck|shit|idiot|scam|spam|http:\/\/|https:\/\/bit\.ly)\b/i.test(t) &&
    !hasDenIntent(t);
}

function isCherryPick(t: string): boolean {
  return /\b(same\s+strain\s+but|0\.5\s*inch\s+smaller|different\s+striation|prettier|another\s+from\s+(the\s+)?batch|custom\s+(fish|pick)|not\s+in\s+(the\s+)?(list|share|video))\b/i.test(
    t,
  );
}

function isStockPick(t: string): boolean {
  return /\b(yellow\s*diamond|as\s+shown|from\s+(the\s+)?(list|share|video)|i('ll| will)?\s+(take|pick|choose)|want\s+the|pair\s+as\s+shown|those\s+fish|this\s+set)\b/i.test(
    t,
  );
}

function isFishMedical(t: string): boolean {
  return /\b(white\s+spots|ich|diagnose|disease|sick\s+fish|fungus|dropsy)\b/i.test(t);
}

function isStockCountAsk(t: string): boolean {
  return /\b(how\s+many\s+(left|available|in\s+stock)|stock\s+count|mortality\s*%?|death\s+rate)\b/i.test(
    t,
  );
}

function isTempFaq(t: string): boolean {
  return /\b(temperature|temp|how\s+warm|28|water\s+temp)\b/i.test(t);
}

function isYellowDiamondFaq(t: string): boolean {
  return /\b(yellow\s*diamond|genetics|wild\s+blood|lineage|bloodline)\b/i.test(t);
}

function isShippingFaq(t: string): boolean {
  return /\b(ship|shipping|doa|delivery|pack(ing)?)\b/i.test(t);
}

function isOutsideShipMention(n: string): boolean {
  return /\b(dubai|mumbai|delhi|pune|kolkata|abroad|usa|uk|singapore|malaysia|goa|rajasthan|gujarat|punjab|odisha|bihar)\b/.test(
    n,
  );
}

/** Collect distinct in-region ship states mentioned (word-safe for 2-letter codes). */
export function collectShipStates(t: string): ShipState[] {
  const n = norm(t);
  const found: ShipState[] = [];
  const add = (code: ShipState) => {
    if (!found.includes(code)) found.push(code);
  };

  for (const [alias, code] of Object.entries(STATE_ALIASES)) {
    // Short codes (tn, kl, …): word-boundary only — avoid "asdfghjkl" → KL
    if (alias.length <= 2) {
      if (new RegExp(`\\b${alias}\\b`, "i").test(n)) add(code);
    } else if (n === alias || n.includes(alias)) {
      add(code);
    }
  }
  for (const [city, code] of Object.entries(CITY_TO_STATE)) {
    if (n.includes(city) || new RegExp(`\\b${city}\\b`).test(n)) add(code);
  }
  return found;
}

/**
 * Parse shipping region from text.
 * - outside: foreign / non-served Indian destinations (beats shipping FAQ)
 * - conflict: ≥2 distinct in-region states in one utterance (TC-36) → clarify, do not pick first
 */
function parseShipState(
  t: string,
): ShipState | "outside" | "unclear" | "conflict" | null {
  const n = norm(t);

  // Explicit abroad / outside — checked before FAQ / in-region aliases
  if (isOutsideShipMention(n)) {
    return "outside";
  }

  const found = collectShipStates(t);
  if (found.length > 1) return "conflict";
  if (found.length === 1) return found[0]!;

  if (/\b(south(\s+india)?|near\s+chennai|somewhere)\b/.test(n) && !CITY_TO_STATE[n]) {
    if (n.includes("chennai")) return "TN";
    return "unclear";
  }

  return null;
}

function experienceSignal(t: string): "yes" | "beginner" | "cheap_one" | null {
  const n = norm(t);
  if (/\b(1\s+small|one\s+small|one\s+cheap|just\s+one|cheap\s+fish|1\s+cheap)\b/.test(n)) {
    return "cheap_one";
  }
  if (
    /\b(beginner|first\s+(aquarium|tank|time)|never\s+kept|new\s+to|researching|no\s+experience)\b/.test(
      n,
    )
  ) {
    return "beginner";
  }
  if (
    /\b(kept\s+discus|discus\s+before|years?|cichlid|tropical|experienced|yes|have\s+kept|2\s+yrs|2\s+years)\b/.test(
      n,
    )
  ) {
    return "yes";
  }
  return null;
}

function tankSignal(t: string, opts?: { allowBareYes?: boolean }): "ready" | "not_ready" | "unsure" | null {
  const n = norm(t);
  if (
    /\b(not\s+(yet|ready|bought)|no\s+heater|buying\s+tank|tiny\s+bowl|single\s+fish\s+only|tank\s+not)\b/.test(
      n,
    )
  ) {
    return "not_ready";
  }
  if (/\b(unsure|custom\s+build|complicated|not\s+sure)\b/.test(n)) {
    return "unsure";
  }
  if (
    /\b(cycled|heater|filtration|filter|mostly\s+ready|4\s*ft|set\s+up|ready\s+for\s+(a\s+)?group)\b/.test(
      n,
    )
  ) {
    return "ready";
  }
  if (opts?.allowBareYes && /^(yes|yep|yeah|ok|okay|ready)\b/.test(n)) {
    return "ready";
  }
  return null;
}

function seriousnessSignal(t: string, opts?: { allowBareYes?: boolean }): "ok" | "haggle" | "cherry" | null {
  const n = norm(t);
  if (isCherryPick(n)) return "cherry";
  if (/\b(lowest|cheapest|haggle|won'?t\s+share|only\s+price|bargain)\b/.test(n)) {
    return "haggle";
  }
  if (
    /\b(comfortable|accept|choose\s+from|happy\s+to|will\s+choose|from\s+(the\s+)?(stock|share|list))\b/.test(
      n,
    )
  ) {
    return "ok";
  }
  if (opts?.allowBareYes && /^(yes|yep|yeah|ok|okay|sure|fine|ready)\b/.test(n)) {
    return "ok";
  }
  return null;
}

const TEXTS = {
  greeting:
    "Welcome to **The Discus Den**, Chennai — glad you reached out. We raise quality discus for keepers who take the hobby seriously. What would you like help with today — a strain, size, or shipping to your state?",
  nudge:
    "Just checking in — happy to help with Den discus stock, shipping, or setup. Which state are you in, or what would you like to know?",
  askLocation:
    "Thanks — that helps. Which state are you in? We currently arrange shipping within a set of southern states.",
  askLocationClarify:
    "Thanks. Could you name the exact state (Tamil Nadu, Kerala, Karnataka, Andhra Pradesh, or Telangana)?",
  askExperience:
    "Thanks — that helps. Have you kept discus before, or other warm-water community / cichlid setups?",
  askTank:
    "Thanks — that helps. Is the tank cycled and ready for a **group** (discus usually do better in 5–6+)? Heater and filtration in place?",
  askSeriousness:
    "We’ll share our **current stock list + videos** — those are the fish available. Are you comfortable choosing from that set, knowing Shiva quotes once you pick (not a public price list)?",
  stockShare:
    "Here’s our current stock share framing: we’ll send the **list + videos** on this chat. **The Discus Den** places orders from this set only — when you’re ready, tell us which of these you’d like.",
  softPrice:
    "Thanks for asking. We don’t publish a rate card here or on the site — once we know your state and setup, Shiva can quote properly. Which state are you in?",
  priceRefuseHard:
    "Thank you for your interest in **The Discus Den**. Without a quick sense of your state and setup we can’t quote properly here — we’ll leave it for now. Whenever you’re ready to share those details for a discus enquiry, message us again and we’ll be glad to help.",
  stateConflictClarify:
    "Thanks — I want to get your shipping state right. You mentioned more than one. Which **one** state should we use: Tamil Nadu, Kerala, Karnataka, Andhra Pradesh, or Telangana?",
  outsideShip: `Thank you so much for your interest in **The Discus Den**. At present we only arrange shipping within Tamil Nadu, Kerala, Karnataka, Andhra Pradesh, and Telangana. You’re very welcome to browse ${SITE} anytime; we’re just not able to fulfil delivery outside these states right now. If that ever changes, we’d be glad to hear from you again.`,
  beginnerSoft:
    "Appreciate you writing in. Discus reward a stable tank and usually do best in a small group (often 5–6+), in warm, clean water. When your system is ready for that, please message us again — we’ll be happy to help you get set up right.",
  tankSoft:
    "Totally fair — better to finish cycling and confirm heater/filtration before fish move. When the tank is ready for a group, come back anytime and we’ll pick up warmly from there.",
  passHandoff:
    "Wonderful — thank you. Your state, experience, tank, and pick from our **current stock share** all look in order. I’m passing this to Shiva at **The Discus Den** for a proper quote / hold on **those** fish. Please keep this chat open; he’ll follow up here.",
  escalateAck:
    "Passing this to Shiva now — thank you for your patience. He’ll follow up on WhatsApp for pricing / hold / special requests.",
  hardSpam:
    "Thank you for your message. We’ll leave it here for now so we can focus on keepers ready for a full enquiry. Whenever you’d like to talk about Den-raised discus with your state and setup, you’re welcome to write again — we’ll be glad to help then.",
  offTopicSoft:
    "Appreciate you reaching out. This WhatsApp is for **The Discus Den** discus enquiries (stock, shipping, setup). I can’t help with that topic here. If you’d like to ask about our discus, I’m right here.",
  offTopicHard:
    "Thanks again for understanding. We’ll close this thread for now so we can stay focused on keepers who need Den discus. Wishing you well — message us anytime with a fish enquiry.",
  gibberishClarify:
    "Thanks for your message. Could you write in simple English which **state** you’re in and what you need from **The Discus Den** (stock, shipping, or setup)?",
  fishMedical:
    "I’m not able to diagnose fish health here. A fish vet or an experienced local keeper is the right call. If you’re also looking at Den stock once your fish are sorted, we’re happy to help with that. Which state are you in?",
  stockRefuse:
    "We don’t share stock counts or mortality figures here. Happy to walk you through a proper enquiry — which state are you in?",
  tempFaq:
    "Discus prefer stable, warm, clean water — roughly **28–30°C**. Happy to continue your enquiry — which state are you in?",
  yellowFaq:
    "Yellow Diamond is a trade name you’ll see on our catalogue. After a short qualify, we’ll share the **current stock list + videos** — please choose from that set. Which state are you in?",
  shippingFaq:
    "Shipping and arrival condition matter to us — we discuss packing and DOA handling carefully with qualified buyers when Shiva takes the order. First, which state are you in?",
  cherrySoft:
    "Thank you for understanding — we only offer the fish shown in our current stock share (we can’t custom-pick “same strain but smaller” or a different striation from the batch). If one of the offered fish works for you, just say which and we’ll continue gladly. If not, no pressure at all — we can pause here.",
  cherryHard:
    "Understood, and thank you for your time. We only place orders from the stock list and videos we send, so we’ll close this enquiry for now. Whenever a current share has what you need and you’re happy to choose from it, message **The Discus Den** again — you’ll be welcome.",
  haggleSoft:
    "We don’t haggle on a public list — Shiva quotes for keepers choosing from our stock share after a short qualify. If you’re open to that process, which state are you in?",
  closedIdle:
    "This enquiry is closed for now. Message **The Discus Den** anytime with a fresh discus enquiry — we’ll be glad to help.",
  strainIntent:
    "Glad you’re looking at strains. After a short qualify we’ll share our current stock list + videos. Which state are you in?",
};

function fillFromMessage(session: FrontDeskSession, t: string): Partial<FrontDeskSession> {
  const patch: Partial<FrontDeskSession> = {};
  const state = parseShipState(t);
  if (
    state &&
    state !== "outside" &&
    state !== "unclear" &&
    state !== "conflict" &&
    !session.shipState
  ) {
    patch.shipState = state;
  }
  const exp = experienceSignal(t);
  if (exp === "yes" && session.experienceOk === undefined) {
    patch.experienceOk = true;
  }
  // Only auto-fill tank on explicit readiness keywords — never bare "yes"
  const tank = tankSignal(t, { allowBareYes: false });
  if (tank === "ready" && session.tankOk === undefined) {
    patch.tankOk = true;
  }
  return patch;
}

function nextGateQuestion(session: FrontDeskSession): { step: Step; text: string } {
  if (!session.shipState) {
    return { step: "location", text: TEXTS.askLocation };
  }
  if (!session.experienceOk) {
    return { step: "experience", text: TEXTS.askExperience };
  }
  if (!session.tankOk) {
    return { step: "tank", text: TEXTS.askTank };
  }
  if (!session.seriousnessOk) {
    return { step: "seriousness", text: TEXTS.askSeriousness };
  }
  return { step: "stock", text: TEXTS.stockShare };
}

/**
 * Process one inbound user text for a WhatsApp contact.
 * Pure rules — one question at a time; mutates in-memory session map.
 */
export function handleFrontDeskMessage(waId: string, rawText: string): FrontDeskReply {
  const session = clone(getSession(waId));
  const text = (rawText ?? "").trim();
  const t = norm(text);

  if (session.closed) {
    return reply(session, TEXTS.closedIdle, "HARD_FAIL");
  }

  // --- Global hard gates ---
  if (isAbuse(t)) {
    return reply(session, TEXTS.hardSpam, "HARD_FAIL");
  }

  // Outside shipping region — check early (before FAQ stubs that match "ship")
  {
    const stEarly = parseShipState(t);
    if (stEarly === "outside") {
      return reply(session, TEXTS.outsideShip, "HARD_FAIL");
    }
  }

  if (isEmptyOrStickerish(t) || isGreeting(t)) {
    if (session.step === "greet" || session.step === "intent") {
      if (isGreeting(t) && session.emptyNudgeCount === 0 && session.step === "greet") {
        return reply(session, TEXTS.greeting, "CONTINUE", {
          step: "intent",
          emptyNudgeCount: 0,
        });
      }
      // empty / sticker / hi loops
      const nudges = session.emptyNudgeCount + (isEmptyOrStickerish(t) || isGreeting(t) ? 1 : 0);
      if (nudges >= 2 && (isEmptyOrStickerish(t) || isGreeting(t))) {
        return reply(session, TEXTS.hardSpam, "HARD_FAIL", { emptyNudgeCount: nudges });
      }
      if (session.step === "greet") {
        return reply(session, TEXTS.greeting, "CONTINUE", {
          step: "intent",
          emptyNudgeCount: nudges,
        });
      }
      return reply(session, TEXTS.nudge, "CONTINUE", { emptyNudgeCount: nudges });
    }
  }

  if (isOffTopic(t)) {
    const count = session.offTopicCount + 1;
    if (count >= 2) {
      return reply(session, TEXTS.offTopicHard, "HARD_FAIL", { offTopicCount: count });
    }
    return reply(session, TEXTS.offTopicSoft, "SOFT_FAIL", { offTopicCount: count });
  }

  if (looksGibberish(t) && !hasDenIntent(t) && !parseShipState(t)) {
    const g = session.gibberishCount + 1;
    if (g === 1) {
      return reply(session, TEXTS.gibberishClarify, "CONTINUE", { gibberishCount: g });
    }
    if (g === 2) {
      return reply(session, TEXTS.offTopicSoft, "SOFT_FAIL", { gibberishCount: g });
    }
    return reply(session, TEXTS.offTopicHard, "HARD_FAIL", { gibberishCount: g });
  }

  if (isVipOrEscalateIntent(t)) {
    return reply(session, TEXTS.escalateAck, "ESCALATE");
  }

  if (isFishMedical(t)) {
    return reply(session, TEXTS.fishMedical, "CONTINUE", {
      step: session.shipState ? session.step : "location",
    });
  }

  if (isStockCountAsk(t)) {
    return reply(session, TEXTS.stockRefuse, "CONTINUE", {
      step: session.shipState ? session.step : "location",
    });
  }

  // Price-only early: soft gate → ask location (never quote). §4[B] / TC-04:
  // after one soft step, refuse-to-qualify / price-only again → HARD_FAIL.
  if (
    (isPriceOnly(t) || (session.priceSoftOffered && isQualifyRefuse(t))) &&
    session.step !== "stock" &&
    !session.seriousnessOk
  ) {
    // If already deep in tree and asking exact price after qualify → escalate
    if (session.shipState && session.experienceOk && session.tankOk) {
      return reply(session, TEXTS.escalateAck, "ESCALATE");
    }
    // Soft already offered and still price-only / refuse qualify → HARD_FAIL
    if (
      session.priceSoftOffered &&
      (isPriceOnly(t) || isQualifyRefuse(t)) &&
      !session.shipState
    ) {
      return reply(session, TEXTS.priceRefuseHard, "HARD_FAIL", {
        softFailCount: session.softFailCount + 1,
      });
    }
    return reply(session, TEXTS.softPrice, "SOFT_FAIL", {
      step: "location",
      softFailCount: session.softFailCount + 1,
      priceSoftOffered: true,
    });
  }

  // FAQ stubs (then resume / ask location)
  if (isTempFaq(t) && session.step === "intent") {
    return reply(session, TEXTS.tempFaq, "CONTINUE", { step: "location" });
  }
  if (isYellowDiamondFaq(t) && (session.step === "greet" || session.step === "intent")) {
    return reply(session, TEXTS.yellowFaq, "CONTINUE", { step: "location" });
  }
  if (isShippingFaq(t) && (session.step === "greet" || session.step === "intent")) {
    const stEarly = parseShipState(t);
    if (stEarly === "outside") {
      return reply(session, TEXTS.outsideShip, "HARD_FAIL");
    }
    return reply(session, TEXTS.shippingFaq, "CONTINUE", { step: "location" });
  }

  // Strain / buy intent from greet/intent
  if (
    (session.step === "greet" || session.step === "intent") &&
    /\b(strain|fish|discus|yellow|buy|want|availability|stock|group|size)\b/i.test(t)
  ) {
    const multi = fillFromMessage(session, t);
    const merged = { ...session, ...multi, step: "location" as Step };
    // Check outside ship in same message
    const st = parseShipState(t);
    if (st === "outside") {
      return reply(merged, TEXTS.outsideShip, "HARD_FAIL", multi);
    }
    if (st === "conflict") {
      return reply(merged, TEXTS.stateConflictClarify, "CONTINUE", {
        ...multi,
        locationClarifyCount: Math.max(1, session.locationClarifyCount),
        step: "location",
      });
    }
    if (st === "unclear") {
      return reply(merged, TEXTS.askLocationClarify, "CONTINUE", {
        ...multi,
        locationClarifyCount: 1,
        step: "location",
      });
    }
    if (multi.shipState) {
      const gate = nextGateQuestion({ ...merged, shipState: multi.shipState });
      return reply(merged, gate.text, "CONTINUE", { ...multi, step: gate.step });
    }
    return reply(merged, TEXTS.strainIntent, "CONTINUE", { ...multi, step: "location" });
  }

  // Multi-answer fill on any step
  {
    const st = parseShipState(t);
    if (st === "outside") {
      return reply(session, TEXTS.outsideShip, "HARD_FAIL");
    }
    // Conflicting in-region states before shipState is locked (TC-36)
    if (st === "conflict" && !session.shipState) {
      const c = session.locationClarifyCount + 1;
      return reply(session, TEXTS.stateConflictClarify, "CONTINUE", {
        step: "location",
        locationClarifyCount: c,
      });
    }
  }

  // --- Step machine ---
  switch (session.step) {
    case "greet":
    case "intent": {
      // price already handled; fall through to location ask
      return reply(session, TEXTS.askLocation, "CONTINUE", { step: "location" });
    }

    case "location": {
      const st = parseShipState(t);
      if (st === "outside") {
        return reply(session, TEXTS.outsideShip, "HARD_FAIL");
      }
      // TC-36: conflicting states in one utterance — warm clarify, do not pick first
      if (st === "conflict") {
        const c = session.locationClarifyCount + 1;
        if (c >= 2) {
          return reply(session, TEXTS.escalateAck, "ESCALATE", {
            locationClarifyCount: c,
          });
        }
        return reply(session, TEXTS.stateConflictClarify, "CONTINUE", {
          locationClarifyCount: c,
        });
      }
      // After soft price gate: still refusing to give a state → HARD_FAIL (TC-04)
      if (
        (st === "unclear" || st === null) &&
        session.priceSoftOffered &&
        (isPriceOnly(t) || isQualifyRefuse(t))
      ) {
        return reply(session, TEXTS.priceRefuseHard, "HARD_FAIL", {
          softFailCount: session.softFailCount + 1,
        });
      }
      if (st === "unclear" || st === null) {
        const c = session.locationClarifyCount + 1;
        if (c >= 2) {
          return reply(session, TEXTS.escalateAck, "ESCALATE", {
            locationClarifyCount: c,
          });
        }
        return reply(session, TEXTS.askLocationClarify, "CONTINUE", {
          locationClarifyCount: c,
        });
      }
      const patched = { ...session, shipState: st, step: "experience" as Step };
      const multi = fillFromMessage(patched, t);
      const merged = { ...patched, ...multi };
      const gate = nextGateQuestion(merged);
      return reply(merged, gate.text, "CONTINUE", { ...multi, shipState: st, step: gate.step });
    }

    case "experience": {
      const exp = experienceSignal(t);
      if (exp === "cheap_one" || exp === "beginner") {
        return reply(session, TEXTS.beginnerSoft, "SOFT_FAIL", {
          softFailCount: session.softFailCount + 1,
          closed: true,
          step: "closed",
        });
      }
      if (exp === "yes" || experienceSignal(t) === "yes") {
        const patched = { ...session, experienceOk: true };
        const multi = fillFromMessage(patched, t);
        const merged = { ...patched, ...multi };
        const gate = nextGateQuestion(merged);
        return reply(merged, gate.text, "CONTINUE", {
          ...multi,
          experienceOk: true,
          step: gate.step,
        });
      }
      // try multi-fill location already done; re-ask experience once
      return reply(session, TEXTS.askExperience, "CONTINUE");
    }

    case "tank": {
      const tank = tankSignal(t, { allowBareYes: true });
      if (tank === "not_ready") {
        return reply(session, TEXTS.tankSoft, "SOFT_FAIL", {
          softFailCount: session.softFailCount + 1,
          closed: true,
          step: "closed",
        });
      }
      if (tank === "unsure") {
        return reply(session, TEXTS.escalateAck, "ESCALATE");
      }
      if (tank === "ready") {
        const patched = { ...session, tankOk: true };
        const gate = nextGateQuestion(patched);
        return reply(patched, gate.text, "CONTINUE", {
          tankOk: true,
          step: gate.step,
        });
      }
      return reply(session, TEXTS.askTank, "CONTINUE");
    }

    case "seriousness": {
      const sig = seriousnessSignal(t, { allowBareYes: true });
      if (sig === "cherry" || isCherryPick(t)) {
        const c = session.cherryPickCount + 1;
        if (c >= 2) {
          return reply(session, TEXTS.cherryHard, "HARD_FAIL", { cherryPickCount: c });
        }
        return reply(session, TEXTS.cherrySoft, "SOFT_FAIL", {
          cherryPickCount: c,
          softFailCount: session.softFailCount + 1,
        });
      }
      if (sig === "haggle") {
        const soft = session.softFailCount + 1;
        if (soft >= 2) {
          return reply(session, TEXTS.hardSpam, "HARD_FAIL", { softFailCount: soft });
        }
        return reply(session, TEXTS.haggleSoft, "SOFT_FAIL", { softFailCount: soft });
      }
      if (sig === "ok") {
        return reply(session, TEXTS.stockShare, "CONTINUE", {
          seriousnessOk: true,
          stockShared: true,
          step: "stock",
        });
      }
      // price ask at this stage → escalate
      if (isPriceOnly(t)) {
        return reply(session, TEXTS.escalateAck, "ESCALATE");
      }
      return reply(session, TEXTS.askSeriousness, "CONTINUE");
    }

    case "stock": {
      if (isCherryPick(t)) {
        const c = session.cherryPickCount + 1;
        if (c >= 2) {
          return reply(session, TEXTS.cherryHard, "HARD_FAIL", { cherryPickCount: c });
        }
        return reply(session, TEXTS.cherrySoft, "SOFT_FAIL", {
          cherryPickCount: c,
          softFailCount: session.softFailCount + 1,
        });
      }
      // PASS only on a clear pick from the offered set (not process-acceptance alone)
      if (
        isStockPick(t) ||
        /\b(as\s+shown|pair\s+as|yellow\s*diamonds?|i('ll| will)?\s+(take|want)\s+the|those\s+\d|group\s+of\s+\d)\b/i.test(
          t,
        )
      ) {
        return reply(session, TEXTS.passHandoff, "PASS");
      }
      if (isPriceOnly(t)) {
        return reply(session, TEXTS.escalateAck, "ESCALATE");
      }
      return reply(session, TEXTS.stockShare, "CONTINUE");
    }

    default:
      return reply(session, TEXTS.closedIdle, "HARD_FAIL");
  }
}

/** Test helper: run a scripted conversation and return replies. */
export function runScript(
  waId: string,
  messages: string[],
): FrontDeskReply[] {
  return messages.map((m) => handleFrontDeskMessage(waId, m));
}

// ---------------------------------------------------------------------------
// Burst coalesce (doc §4 / TC-35)
// ---------------------------------------------------------------------------

/**
 * Coalesce window for same-waId rapid inbound texts.
 * Spec: ~8–15 seconds (or until pause). Midpoint used as default.
 */
export const BURST_COALESCE_MS = 12_000;

type BurstState = {
  parts: string[];
  timer: ReturnType<typeof setTimeout> | null;
  /** Single shared promise for this burst — resolved once on flush. */
  deferred: Promise<FrontDeskReply>;
  resolve: (reply: FrontDeskReply) => void;
  /** onReply callbacks — invoked exactly once when the burst flushes. */
  listeners: Array<(reply: FrontDeskReply) => void | Promise<void>>;
};

const bursts = new Map<string, BurstState>();

export function resetBursts(): void {
  for (const b of bursts.values()) {
    if (b.timer) clearTimeout(b.timer);
  }
  bursts.clear();
}

function flushBurstNow(waId: string): void {
  const state = bursts.get(waId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  bursts.delete(waId);
  const combined = state.parts
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .join("\n");
  const reply = handleFrontDeskMessage(waId, combined);
  state.resolve(reply);
  for (const listener of state.listeners) {
    try {
      void listener(reply);
    } catch {
      // soft — webhook send errors handled by caller
    }
  }
}

/**
 * Buffer rapid inbound texts for the same waId and process as one combined
 * message after {@link BURST_COALESCE_MS} (or opts.coalesceMs).
 *
 * - Returns a Promise that resolves with the single coalesced reply.
 * - `onReply` (if provided) is called **once** when the burst flushes — use
 *   this in the webhook so outbound send is not duplicated.
 * - Pass `coalesceMs: 0` (or negative) to process immediately (tests / bypass).
 */
export function ingestInboundText(
  waId: string,
  rawText: string,
  opts?: {
    coalesceMs?: number;
    onReply?: (reply: FrontDeskReply) => void | Promise<void>;
  },
): Promise<FrontDeskReply> {
  const ms = opts?.coalesceMs ?? BURST_COALESCE_MS;
  if (ms <= 0) {
    const reply = handleFrontDeskMessage(waId, rawText);
    if (opts?.onReply) void opts.onReply(reply);
    return Promise.resolve(reply);
  }

  let state = bursts.get(waId);
  if (!state) {
    let resolve!: (reply: FrontDeskReply) => void;
    const deferred = new Promise<FrontDeskReply>((r) => {
      resolve = r;
    });
    state = {
      parts: [],
      timer: null,
      deferred,
      resolve,
      listeners: [],
    };
    bursts.set(waId, state);
  }

  state.parts.push(rawText ?? "");
  if (opts?.onReply) state.listeners.push(opts.onReply);

  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => flushBurstNow(waId), ms);

  return state.deferred;
}

/** Force-flush a pending burst (tests). Returns the coalesced reply, or undefined. */
export function flushBurst(waId: string): FrontDeskReply | undefined {
  const state = bursts.get(waId);
  if (!state) return undefined;
  const combined = state.parts
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .join("\n");
  if (state.timer) clearTimeout(state.timer);
  bursts.delete(waId);
  const replyResult = handleFrontDeskMessage(waId, combined);
  state.resolve(replyResult);
  for (const listener of state.listeners) {
    try {
      void listener(replyResult);
    } catch {
      // soft
    }
  }
  return replyResult;
}

/** Peek buffered parts for a waId (tests). */
export function peekBurstParts(waId: string): string[] | undefined {
  const s = bursts.get(waId);
  return s ? [...s.parts] : undefined;
}
