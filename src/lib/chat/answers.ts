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
  "Orders of 5–9 fish get 5% off and 10 or more get 10% off, applied in the cart.";

export const PER_PIECE_LINE = "All prices are per piece. A pair is two pieces.";

export const ANSWERS = {
  // Section 2
  welcome:
    "Welcome to The Discus Den. Not a pet shop. Our discus are raised, quarantined and held until they're ready. How can I help?",
  availableIntro: "Here's what's in the window now:",
  availableOutro: "Full list: thediscusden.com/available\nWant me to narrow it down by size or colour?",
  liveFetchFailed:
    "I can't load the live list right now. You can see it here: thediscusden.com/available. Or I can pass your question to Shiva.",
  strainNotListed:
    "That one isn't on our available page right now. Want me to ask Shiva about it?",
  bundledVariant: "That card covers more than one variant at one listed price. For a specific variant, Shiva can advise. Shall I pass your details?",
  careTips: [
    "A few calm basics:",
    "1. Settle the tank fully before fish arrive. If yours isn't ready yet, we can hold first-timers' fish while it settles.",
    "2. Keep a steady routine: same feeding and lighting times, and no sudden changes.",
    "3. Do regular water changes. Clean, stable water matters most.",
    "4. Keep the temperature steady, around 28–30°C.",
    "5. Feed a variety: quality pellets plus frozen foods.",
    "6. Ask before you buy. Shiva will help match fish to your tank.",
    "Want me to connect you with Shiva?",
  ].join("\n"),

  // Section 3: handoff script
  handoffAskName: "Sure. May I have your name?",
  handoffAskPhone: (name?: string) =>
    name
      ? `Thanks, ${name}. What's the best WhatsApp or phone number for Shiva to reach you?`
      : "Thanks. What's the best WhatsApp or phone number for Shiva to reach you?",
  handoffPhoneRetry: "A working WhatsApp number, please.",
  handoffAskCity: "Which city are you in?",
  handoffAskPairSingle: "Are you looking at a pair or single fish?",
  handoffAskDelivery: "Would you prefer train shipping or Chennai pickup?",
  handoffAskTimeline: "Is your tank ready now, or a few weeks away?",
  handoffClose: (name?: string) =>
    name
      ? `Thank you, ${name}. I've passed this to Shiva with our chat. He'll get back to you personally.`
      : "Thank you. I've passed this to Shiva with our chat. He'll get back to you personally.",
  /** Not in the pack: used when no valid number was given, so nothing is "passed". */
  handoffNoNumber:
    "No problem. Without a number Shiva can't reach you. Whenever you're ready, tap Talk to Shiva and I'll take your details.",
  /** Not in the pack: a number without a name can't be marked as a lead. */
  handoffNeedName: "Thanks. What name should Shiva use when he reaches you?",
  handoffNoName:
    "No problem. Shiva needs a name and number to reach you. Whenever you're ready, tap Talk to Shiva and I'll take your details.",
  handoffAlreadyDone:
    "I've already passed your details to Shiva with our chat. He'll get back to you personally. Anything else I can help with?",
  handoffDeclined: "No problem. Anything else I can help with?",

  // Section 4: FAQs
  faqStrains:
    "Our live list is here: thediscusden.com/available. Each card shows the strain, size and price. Want me to narrow it down by size or colour?",
  shippingExtra: "Shipping is extra. Shiva sends a shipping estimate after your order.",
  beginnerIntro: "A good entry strain is",
  beginnerOutro: "Shiva can help match fish to your tank too. Want me to connect you?",
  beginnerNotListed:
    "Shiva is the best person to suggest a starter strain from what's ready now. Shall I pass your details?",
  pairOrSingle:
    "That depends on your tank and plans. Shiva will advise you personally. Shall I connect you?",
  shipInStates:
    "We deliver by train across Tamil Nadu, Kerala, Karnataka, Andhra Pradesh, Telangana, Maharashtra, Madhya Pradesh and Odisha. Chennai pickup is also possible.",
  shipOtherState:
    "We can deliver to other states on request. Shiva will confirm the route and timing with you. Shall I pass your details?",
  shipRemote:
    "We'll try our best, but we can't guarantee safe arrival over very long journeys. Shiva will talk it through with you. Shall I pass your details?",
  ordering:
    "Pick your fish on thediscusden.com/available and finalise in the cart. There's no payment on the site. Your list goes to Shiva, who follows up with you personally. Shipping is extra and is estimated after you order.",
  howToPay:
    "There's no payment on the site. Payment is by GPay. Shiva shares the payment details himself when he confirms your order, so please only pay details he gives you directly.",
  paymentDetails:
    "Shiva shares payment details himself when he confirms your order. Please only pay details he gives you directly.",
  shippingCost: "Shipping is extra. Shiva sends an estimate after you place your order.",
  // [PENDING ST-6] minimal draft, no dates or day counts until Shiva locks it.
  shippingHow:
    "After you confirm, your fish rest in a holding tank before travel, with updates from Shiva. They go by train through a railway agent, and you collect at the station or have them ported home. Shiva confirms the timing with you.",
  doa:
    "If a fish arrives dead, we refund it promptly. Please record a clear unboxing video and send it to Shiva within 24 hours of arrival. Shiva reviews every claim personally.",
  visit:
    "Yes, store shopping and pickup in Chennai are possible by arrangement. Shiva will share the location and set a time with you. Shall I pass your details?",
  pickup: "Yes. Chennai pickup is possible. Shiva sets a time with you personally. Want me to pass your details?",
  quarantine:
    "Yes. Fish are quarantined, fed and watched before they leave. We hold them until they're ready, and Shiva would rather refuse a shipment than send a stressed fish.",
  holding:
    "Yes. We hold fish for up to 7 days free. After that there's a maintenance charge of ₹100 per day for the whole purchase, not per fish.",
  holdingBeyond: "Anything beyond that is Shiva's call. Shall I pass your details?",
  foodIntro: "Yes. We have",
  foodOutro: "See thediscusden.com/in-the-den.",
  foodFetchFailed:
    "Yes, we have frozen foods and pellets. I can't load the live rates right now. You can see them at thediscusden.com/in-the-den. Or I can pass your question to Shiva.",
  goatHeartPending: "Goat Heart Mix rates are coming soon. Want Shiva to let you know?",
  reseller: "Thanks. Shiva handles trade enquiries personally. Shall I pass your details to him?",
  sickFish:
    "Sorry to hear that. I can't give health or treatment advice here, but Shiva can talk it through with you personally. Shall I pass your details to him now?",
  discount: "Shiva handles offers personally. Want me to pass your details to him?",
  strainNotListedAsk:
    "That one isn't on our available page right now. Shiva can tell you if it's coming. Shall I ask him?",

  // Section 1 behaviour
  promptAttack: "I can help with discus and The Discus Den. What are you looking for?",
  offTopic: "I can help with discus and The Discus Den. What are you looking for?",
  areYouHuman: "I'm The Discus Den's chat assistant. Shiva reads every handoff personally.",
  /** Rule 1/2/3: no stock figures, losses or sources. Not verbatim in the pack. */
  noInternalFigures:
    "I can't share that here. Our available page shows what's ready now: thediscusden.com/available. Want me to narrow it down by size or colour?",
  /** "Uncertainty: offer the handoff. Don't improvise." */
  unsure: "I'm not sure about that one. Shall I pass your question to Shiva?",
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
  | `STRAIN NOT LISTED: ${string}`;
