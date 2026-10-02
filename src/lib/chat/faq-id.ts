/**
 * Test / QA support: map a bot reply back to the answer-pack entry it came from.
 *
 * Used by the table-driven regression suite (qa-cases.test.ts) so each QA prompt
 * can be pinned to an FAQ id ("FAQ 21", "FAQ 5 other", "handoff:city"...) rather
 * than to exact text that includes live prices. Not used at runtime.
 */

import { ANSWERS, ownerReply, PER_PIECE_LINE } from "./answers.ts";

const FIXED: Array<[string, string]> = [
  [ANSWERS.lossSafetyNet, "FAQ 26"],
  [ANSWERS.promptAttack, "attack"],
  [ANSWERS.mortality, "FAQ 21"],
  [ANSWERS.claimedOffer, "FAQ 22"],
  [ANSWERS.offTopic, "FAQ 23"],
  [ANSWERS.unclear, "FAQ 24 unclear"],
  [ANSWERS.shipAbroad, "FAQ 25"],
  [ANSWERS.unsure, "last-resort"],
  [ANSWERS.doa, "FAQ 10"],
  [ANSWERS.shipInStates, "FAQ 5"],
  [ANSWERS.shipOtherState, "FAQ 5 other"],
  [ANSWERS.shipRemote, "FAQ 5 remote"],
  [ANSWERS.discount, "FAQ 19"],
  [ANSWERS.paymentDetails, "Rule 5a"],
  [ANSWERS.howToPay, "FAQ 7"],
  [ANSWERS.ordering, "FAQ 6"],
  [ANSWERS.shippingCost, "FAQ 8"],
  [ANSWERS.shippingHow, "FAQ 9"],
  [ANSWERS.visit, "FAQ 11"],
  [ANSWERS.pickup, "FAQ 12"],
  [ANSWERS.quarantine, "FAQ 13"],
  [ANSWERS.holding, "FAQ 14"],
  [ANSWERS.foodFetchFailed, "FAQ 15"],
  [ANSWERS.goatHeartPending, "FAQ 16"],
  [ANSWERS.reseller, "FAQ 17"],
  [ANSWERS.sickFish, "FAQ 18"],
  [ANSWERS.strainNotListedAsk, "FAQ 20"],
  [ANSWERS.strainNotListed, "FAQ 20"],
  [ANSWERS.pairOrSingle, "FAQ 4"],
  [ANSWERS.beginnerNotListed, "FAQ 3"],
  [ANSWERS.beginnerIntro, "FAQ 3"],
  [ANSWERS.faqStrains, "FAQ 1"],
  [ANSWERS.noInternalFigures, "internal"],
  [ANSWERS.stockFetchFailed, "C1 stock"],
  [ANSWERS.areYouHuman, "are-you-human"],
  [ANSWERS.welcome, "welcome"],
  [ANSWERS.careTips, "care-tips"],
  [ANSWERS.liveFetchFailed, "live-fetch-failed"],
  [ANSWERS.thanks, "thanks"],
  [ANSWERS.bye, "bye"],
  [ANSWERS.handoffAskName, "handoff:name"],
  [ANSWERS.handoffPhoneRetry, "handoff:phone"],
  [ANSWERS.handoffAskCity, "handoff:city"],
  [ANSWERS.handoffAskPairSingle, "handoff:pairSingle"],
  [ANSWERS.handoffAskDelivery, "handoff:delivery"],
  [ANSWERS.handoffAskTimeline, "handoff:timeline"],
  [ANSWERS.handoffNeedName, "handoff:name"],
  [ANSWERS.handoffNoNumber, "handoff:incomplete"],
  [ANSWERS.handoffNoName, "handoff:incomplete"],
  [ANSWERS.handoffAlreadyDone, "handoff:already-done"],
  [ANSWERS.handoffDeclined, "declined"],
  [ANSWERS.tooLong, "too-long"],
  [ANSWERS.emptyMessage, "empty"],
  [ANSWERS.badSession, "bad-session"],
  [ANSWERS.rateLimited, "rate-limited"],
  [ANSWERS.serverError, "server-error"],
  [PER_PIECE_LINE, "FAQ 2"],
  [ANSWERS.bundledVariant, "FAQ 2"],
];

function stripOffer(text: string): string {
  return text.replace(/\s*(Shall I|Want me to|Want Shiva to|Or I can)[^.?\n]*[.?]\s*$/i, "").trim();
}

/** Id of the first paragraph of a reply (the answer itself; later paragraphs are follow-ups). */
export function faqIdOf(reply: string): string {
  const first = reply.split("\n\n")[0]!.trim();
  for (const [text, id] of FIXED) if (first.startsWith(text)) return id;
  // Side answers inside a handoff drop their trailing offer ("Shall I pass your details?").
  for (const [text, id] of FIXED) {
    const core = stripOffer(text);
    if (core.length >= 20 && core !== text && first.startsWith(core)) return id;
  }
  if (first.startsWith(ANSWERS.availableIntro)) return "FAQ 1";
  if (first.startsWith(ANSWERS.stockIntro)) return "C1 stock";
  if (first.startsWith(`${ANSWERS.quarantineShipYes} ${ANSWERS.quarantine}`)) return "LB-3";
  if (first.startsWith("•") && /: (in stock right now|out of stock right now|see \S+ for current availability)\.$/m.test(first)) return "C1 stock";
  if (first.startsWith(ownerReply("").split(",")[0]!.trim())) return "B12 owner";
  if (first.startsWith("•")) return "FAQ 2";
  if (first.startsWith(`${ANSWERS.foodIntro} `)) return "FAQ 15";
  if (/^Goat Heart Mix\b/.test(first)) return "FAQ 16";
  if (/^Nothing on our available page matches/.test(first)) return "FAQ 1";
  if (/^Sure\. Which size or colour/.test(first)) return "narrow";
  if (/^Thanks(, [^.]+)?\. What's the best WhatsApp/.test(first)) return "handoff:phone";
  if (/^Thanks, [^.]+\. How can I help\?/.test(first)) return "name-given";
  if (/^Thank you(, [^.]+)?\. I've passed this to Shiva/.test(first)) return "handoff:close";
  return "other";
}
