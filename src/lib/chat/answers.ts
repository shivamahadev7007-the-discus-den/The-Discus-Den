/**
 * The Discus Den website Chat Assistant: answer pack as data.
 *
 * Source: den-sales/chat-bot-sales-answers.md (Anita, updated 2 Oct 2026).
 * Wording is kept as close to the pack as possible. Replies are plain text
 * (no markdown) because the site widget renders the reply string as-is.
 *
 * Hard rules live in guard.ts (last line of defence) and in the router
 * (engine.ts). Nothing here may contain prices, phone numbers, payment
 * details, stock figures, supplier names or any discount code.
 */

export const SITE_URL = "https://thediscusden.com";
export const AVAILABLE_URL = `${SITE_URL}/available`;
export const FROZEN_URL = `${SITE_URL}/frozen`;
export const PELLETS_URL = `${SITE_URL}/pellets`;

/** The 8 states served by train (site + Shiva, 2 Oct). */
export const SHIP_STATES = [
  "Tamil Nadu",
  "Kerala",
  "Karnataka",
  "Andhra Pradesh",
  "Telangana",
  "Maharashtra",
  "Madhya Pradesh",
  "Odisha",
] as const;

export const QUICK_TAPS = ["What fish are available?", "Care tips", "Talk to Shiva"] as const;

export const VOLUME_DISCOUNT_LINE =
  "Orders of 5–9 fish get 5% off and 10 or more get 10% off, applied in the Shopping Bag.";

/**
 * LB-6 (Shiva, 3 Oct): the site steps, as on the live site. Used after
 * discount / quantity answers and in "can I order on chat?".
 */
export const SITE_STEPS =
  "To order: open Current Stock (thediscusden.com/available), choose a quantity on a card, open the Shopping Bag, tap Finalize, add your details and tap Place request. There's no payment on the site. Once your request is placed, Shiva is notified and takes it from there.";

/**
 * LB-6 (Shiva, 3 Oct): any place outside the 8 train states (other states,
 * remote places, abroad). Never a refusal; a tentative, care-first handoff.
 * Shiva's suggested wording; "[City]" is the place the visitor named.
 */
export const OUT_OF_AREA_LEAD =
  "We only send fish when we're sure they'll arrive in optimal condition, never tired from a long journey.";
export function outOfAreaReply(place?: string, abroad = false): string {
  const where = place ? `${place} isn't` : "Your location isn't";
  const route = abroad ? "our regular route" : "our regular train route";
  return `${OUT_OF_AREA_LEAD} ${where} on ${route} yet, so Shiva would like to personally check the best route for you. Shall I pass your details to him?`;
}

export const PER_PIECE_LINE = "All prices are per piece. A pair is two pieces.";

export const ANSWERS = {
  // Section 2
  welcome:
    "Welcome to The Discus Den. Not a pet shop. Our discus are raised, quarantined and held until they're ready. How can I help?",
  availableIntro: "Here's what's in the window now:",
  availableOutro: "Full list: thediscusden.com/available\nWant me to narrow it down by size or colour?",
  liveFetchFailed:
    "I can't load the live list right now. You can see it here: thediscusden.com/available.",
  strainNotListed:
    "That one isn't on our available page right now. Want me to ask Shiva about it?",
  /** LB-6 D2: no generic handoff offer; Shiva advises after the request is placed. */
  bundledVariant:
    "That card covers more than one variant at one listed price. Once you place a request from the Shopping Bag, Shiva is notified and can advise on the variant.",
  careTips: [
    "A few calm basics:",
    "1. Settle the tank fully before fish arrive. If yours isn't ready yet, we can hold first-timers' fish while it settles.",
    "2. Keep a steady routine: same feeding and lighting times, and no sudden changes.",
    "3. Do regular water changes. Clean, stable water matters most.",
    "4. Keep the temperature steady, around 28–30°C.",
    "5. Feed a variety: quality pellets plus frozen foods.",
    "6. Shiva will help match fish to your tank once your request is placed.",
    "Everything else is on thediscusden.com. Once you place a request from the Shopping Bag, Shiva is notified and takes it from there.",
  ].join("\n"),

  // Section 3: handoff script
  handoffAskName: "Sure. May I have your name?",
  handoffAskPhone: (name?: string) =>
    name
      ? `Thanks, ${name}. What's the best WhatsApp or phone number for Shiva to reach you?`
      : "Thanks. What's the best WhatsApp or phone number for Shiva to reach you?",
  handoffPhoneRetry: "A working WhatsApp number, please.",
  handoffAskCity: "Which city are you in?",
  /** LB-11 (Shiva, 3 Oct): replaces the old pair-or-single question; asked right after the name. */
  handoffAskLookingFor: "Are you looking for Discus fish or Discus frozen foods?",
  /** LB-11 pointers after that answer. Pages checked live 3 Oct 12:25 IST: /available, /frozen, /pellets. */
  lookingForFish:
    "Great. Everything ready now is on Current Stock (thediscusden.com/available): choose a quantity on a card, then open the Shopping Bag, tap Finalize and Place request.",
  lookingForFood:
    "Great. Our frozen foods are on thediscusden.com/frozen and pellets on thediscusden.com/pellets: choose a pack, then open the same Shopping Bag, tap Finalize and Place request.",
  lookingForBoth:
    "Great. Fish are on Current Stock (thediscusden.com/available), frozen foods on thediscusden.com/frozen and pellets on thediscusden.com/pellets. Everything goes in the same Shopping Bag: tap Finalize, then Place request.",
  handoffAskDelivery: "Would you prefer train shipping or Chennai pickup?",
  handoffAskTimeline: "Is your tank ready now, or a few weeks away?",
  handoffClose: (name?: string) =>
    name
      ? `Thank you, ${name}. I've passed this to Shiva with our chat. He'll get back to you personally.`
      : "Thank you. I've passed this to Shiva with our chat. He'll get back to you personally.",
  /** Not in the pack: used when no valid number was given, so nothing is "passed". */
  handoffNoNumber:
    "No problem. Without a number Shiva can't reach you. You're welcome to share it here any time.",
  /** Not in the pack: a number without a name can't be marked as a lead. */
  handoffNeedName: "Thanks. What name should Shiva use when he reaches you?",
  handoffNoName:
    "No problem. Shiva needs a name and number to reach you. You're welcome to share them here any time.",
  handoffAlreadyDone:
    "I've already passed your details to Shiva with our chat. He'll get back to you personally. Anything else I can help with?",
  handoffDeclined: "No problem. Anything else I can help with?",

  // Section 4: FAQs
  faqStrains:
    "Our live list is here: thediscusden.com/available. Each card shows the strain, size and price. Want me to narrow it down by size or colour?",
  shippingExtra: "Shipping is extra. Shiva sends a shipping estimate after your order.",
  beginnerIntro: "A good entry strain is",
  /** LB-6 D2: these three no longer offer a handoff; they point to the site's request flow. */
  beginnerOutro: "Once you place a request from the Shopping Bag, Shiva is notified and can help match fish to your tank too.",
  beginnerNotListed:
    "Our live list is at thediscusden.com/available. Once you place a request from the Shopping Bag, Shiva is notified and can suggest a starter strain from what's ready now.",
  /** LB-11: "should I buy a pair?" -> per piece, choose the quantity (site steps follow). */
  howManyToBuy:
    "That depends on your tank and plans. All prices are per piece, and you choose the quantity on each card. Shiva can advise on your tank once your request is placed.",
  shipInStates:
    "We deliver by train across Tamil Nadu, Kerala, Karnataka, Andhra Pradesh, Telangana, Maharashtra, Madhya Pradesh and Odisha. Chennai pickup is also possible.",
  /**
   * LB-6 (Shiva, 3 Oct): how to order = steer to the site. Button and page names
   * are the live site's own (3 Oct 11:30 IST): "Current Stock" page, quantity on
   * each card, "Shopping Bag", "Finalize", "Place request"; "No payment here";
   * "Shipping is extra ... we will send a shipping estimate".
   */
  ordering:
    "Everything is on our website and it's self-explanatory. To order: open Current Stock (thediscusden.com/available), choose a quantity on each card, open the Shopping Bag, tap Finalize, add your details and tap Place request. There's no payment on the site. Shipping is extra: after you place the request, we send you a shipping estimate. Once your request is placed, Shiva is notified and takes it from there.",
  /** LB-6: a push to reach a human / Shiva gets a warm steer to the site, not a handoff. */
  humanPush:
    "I understand you'd like to reach Shiva. The quickest way is through our website: everything is on thediscusden.com and it's self-explanatory. To order, open Current Stock (thediscusden.com/available), choose a quantity on a card, open the Shopping Bag, tap Finalize, add your details and tap Place request. There's no payment on the site. Once your request is placed, Shiva is notified and will take it from there.",
  /** LB-6: repeated pushes get the same steer, shorter. */
  humanPushShort:
    "All the details are on thediscusden.com. To order, choose your fish on thediscusden.com/available, then open the Shopping Bag, tap Finalize and Place request. Shiva is notified as soon as your request is placed and will take it from there.",
  /**
   * LB-6 SOP (Shiva, 3 Oct) for first-timers and orders outside Chennai (not
   * store pickup). Default flow; the 7-days-free / ₹100-a-day line is only for
   * customers who ask us to keep fish longer. Payment method only, never a number.
   */
  sopIntro: "If you're outside Chennai or ordering for the first time, here's how it works:",
  sop:
    "1. Your fish are moved to a separate customer holding tank.\n2. They're fasted for two days, and you get an update from us every day during this time.\n3. Shipping happens on day three, most likely the coming Saturday or Sunday.\n4. Shipping is by train. We give you a railway agent's contact: you can collect the fish at the station by speaking with the agent, or have them ported from the station to your place.\n5. Payment: half the amount as advance once your fish are moved to the holding tank, and the balance on shipping day, before dispatch.",
  /** LB-6 B3 (Lea, 3 Oct): "can I order on chat?" -> plain "No" + the site steps (audit exemption). */
  orderInChat: `No, orders go through our website, not this chat. ${SITE_STEPS}`,
  /** LB-6 B6: how the customer knows the request went through (site wording: "Request placed"). */
  orderReceived:
    "When you tap Place request in the Shopping Bag, the site shows \"Request placed\" and Shiva is notified straight away. He then contacts you on the WhatsApp number you entered in the form.",
  /** LB-6 C7: station collection = SOP step 4 (train), not Chennai store pickup. */
  stationPickup:
    "For train orders, we give you a railway agent's contact: you can collect the fish at the station by speaking with the agent, or have them ported from the station to your place.",
  /** LB-6 C5: SOP payment step. Method only; never a number. */
  payAdvance:
    "Not the full amount up front. You pay half the amount as advance once your fish are moved to the holding tank, and the balance on shipping day, before dispatch. There's no payment on the site: Shiva shares the payment details himself, so please only pay details he gives you directly.",
  /** LB-6 D1: light small talk gets a warm redirect instead of the clarifying question. */
  smallTalk:
    "Happy to chat discus! I'm here for The Discus Den's fish, food and orders. You can see what's ready now at thediscusden.com/available.",
  howToPay:
    "There's no payment on the site. Payment is by GPay. Shiva shares the payment details himself when he confirms your order, so please only pay details he gives you directly.",
  paymentDetails:
    "Shiva shares payment details himself when he confirms your order. Please only pay details he gives you directly.",
  shippingCost: "Shipping is extra. Shiva sends an estimate after you place your order.",
  // [PENDING ST-6] minimal draft, no dates or day counts until Shiva locks it.
  /** FAQ 9, aligned to the LB-6 SOP: the SOP itself is the answer (see engine). */
  shippingHow: "Here's how delivery works for orders outside Chennai:",
  doa:
    "If a fish arrives dead, we refund it promptly. Please record a clear unboxing video and send it to Shiva within 24 hours of arrival. Shiva reviews every claim personally.",
  visit:
    "Store visits and pickup in Chennai are possible by arrangement. Shiva will share the location and set a time with you. Shall I pass your details?",
  pickup: "Chennai pickup is possible. Shiva sets a time with you personally. Want me to pass your details?",
  quarantine:
    "Every fish is quarantined, fed and watched before it leaves. We hold them until they're ready, and Shiva would rather refuse a shipment than send a stressed fish.",
  holding:
    "We can hold fish for up to 7 days free. After that there's a maintenance charge of ₹100 per day for the whole purchase, not per fish.",
  /**
   * LB-3 (Shiva, 3 Oct): "you quarantine the fish and ship it to me?" is a plain
   * factual question, so this combined answer opens with "Yes." (the only
   * exemption from the no-"Yes"-opener audit), then FAQ 13 + FAQ 14 verbatim,
   * then the delivery answer for the visitor's place (FAQ 5 / 25).
   */
  quarantineShipYes: "Yes.",
  holdingBeyond: "Anything beyond that is Shiva's call. Shall I pass your details?",
  foodIntro: "We have",
  foodOutro: "See thediscusden.com/in-the-den.",
  foodFetchFailed:
    "We have frozen foods and pellets. I can't load the live rates right now. You can see them at thediscusden.com/in-the-den.",
  goatHeartPending: "Goat Heart Mix rates are coming soon. Keep an eye on thediscusden.com/in-the-den.",
  reseller: "Thanks. Shiva handles trade enquiries personally. Shall I pass your details to him?",
  sickFish:
    "Sorry to hear that. I can't give health or treatment advice here, but Shiva can talk it through with you personally. Shall I pass your details to him now?",
  /** LB-6 (Shiva, 3 Oct): discount asks -> volume discounts (automatic in the Shopping Bag) + site steps. No handoff, no codes. */
  discount:
    "Volume discounts apply automatically in the Shopping Bag: 5% off for 5–9 fish and 10% off for 10 or more.",
  strainNotListedAsk:
    "That one isn't on our available page right now. Shiva can tell you if it's coming. Shall I ask him?",

  // Section 1 behaviour
  promptAttack: "I can help with discus and The Discus Den. What are you looking for?",
  /** FAQ 23: off-topic requests (code, homework, weather, news...). */
  offTopic: "I can only help with The Discus Den's fish, food and orders. Is there something there I can help with?",
  /** LB-6 A4: followed by the site steer (engine). */
  areYouHuman: "I'm The Discus Den's chat assistant, not a person.",
  /** FAQ 21 (pack rev. 19:54): mortality questions. Never "Yes"/"No", never numbers. */
  mortality:
    "Every fish is quarantined, fed and watched before it leaves, and Shiva only ships fish that are eating and settled. Happy to pass any detailed questions to him.",
  /** FAQ 22: claimed promises or offers. Takes priority over FAQ 14 (holding) and FAQ 19 (discounts). */
  claimedOffer: "I can't confirm or apply that here. Shiva will check it with you personally. Shall I pass your details to him?",
  /**
   * C1 (Shiva's ruling, 3 Oct): availability only. The bot says whether a card
   * is in or out of stock, as the live site shows it, and NEVER how many.
   * Lines are built per card in engine.ts; these are the fixed parts.
   */
  stockPage: "thediscusden.com/available",
  stockIntro: "Here's what the site shows as in stock right now:",
  stockOutro:
    "Availability is as shown on thediscusden.com/available right now.", // LB-6 (Shiva, 3 Oct): no quantity handoff; site steps follow
  stockListOutro: "Full list: thediscusden.com/available.",
  stockFetchFailed:
    "I can't load live availability right now. You can check thediscusden.com/available.",
  /**
   * LB-5 (Shiva, 3 Oct): sizes, ages, cheaper options or anything else not
   * listed get a warm but firm close. No cards, no prices, no discount line,
   * no "I'll check", no handoff. [PENDING Anita/Shiva sign-off on wording;
   * "for sale" from the suggested text dropped: "sale" is a guard shop-word.]
   */
  unlistedFirm:
    "What's listed on thediscusden.com/available is everything we have right now, so we can't offer other sizes, ages or prices. Please pick from that page.",
  /** Rule 1/2/3: no loss figures or sources (not on the site). Not verbatim in the pack. */
  noInternalFigures:
    "I can't share that here. Our available page shows what's ready now: thediscusden.com/available. Want me to narrow it down by size or colour?",
  /** FAQ 24: "If still unclear" clarifying question (never just "I'm not sure"). */
  unclear: "Sorry, I didn't catch that. Are you asking about our fish, prices, or delivery?",
  /**
   * FAQ 26 (pack rev. 20:19): safety net for any death, loss or refund message.
   * Runs before every other answer and replaces FAQ 10 and 21 when triggered.
   */
  lossSafetyNet:
    "Every fish is quarantined, fed and settled before it ships, and we don't share loss figures. If a fish arrived dead, please send Shiva a clear unboxing video within 24 hours of arrival. He reviews every claim personally, and I can't approve refunds here. Shall I pass your details to him?",
  /** Last-resort reply (pack wording, approved 2 Oct): the output guard's safe replacement. */
  /** LB-6 D2: no generic handoff offer; steer to the site. */
  unsure:
    "Everything is on thediscusden.com and it's self-explanatory. Once you place a request from the Shopping Bag, Shiva is notified and takes it from there.",
  /** FAQ 25: delivery abroad. Hand off; flags OUTSIDE 8 STATES + REMOTE. Never promise international shipping. */
  thanks: "You're welcome. Anything else I can help with?",
  bye: "Thank you for visiting The Discus Den. Take care.",

  // Transport-level replies (http.ts)
  emptyMessage: "Please type a message and I'll help.",
  tooLong: "That message is a bit long. Please keep it under 1000 characters.",
  badSession: "Something went wrong with this chat. Please refresh the page and try again.",
  rateLimited:
    "You're sending messages a little fast. Please wait a few minutes and try again, or browse thediscusden.com/available meanwhile.",
  serverError:
    "Sorry, I'm having trouble right now. Please try again in a moment, or see thediscusden.com/available.",
} as const;

/** B12 (3 Oct rule): the owner's name as the site footer shows it. Never a number. */
export const OWNER_FALLBACK = "Shiva";
export function ownerReply(owner: string): string {
  // LB-6: no handoff offer; steer to the site instead.
  return `The Discus Den is run by ${owner}, here in Chennai, as shown on our website. Everything you need is on thediscusden.com, and once you place a request from the Shopping Bag, ${owner} is notified and takes it from there.`;
}

/** Lead flags, as named in section 3 of the pack. */
export type LeadFlag =
  | "RESELLER"
  | "SICK FISH"
  | "DISCOUNT ASKED"
  | "OUTSIDE 8 STATES"
  | "REMOTE"
  | "GUARANTEE ASKED"
  | "PAYMENT ASKED"
  | "DOA CLAIM"
  | "LONG HOLD"
  | "MORTALITY ASKED"
  | "CLAIMED OFFER"
  | `STRAIN NOT LISTED: ${string}`;
