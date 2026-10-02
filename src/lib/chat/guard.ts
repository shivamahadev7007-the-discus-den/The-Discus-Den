/**
 * Output guard: the last line of defence on every reply leaving /api/chat.
 *
 * 1. Strips phone-number-like digit runs (7+ digits, with spaces/dashes/+/dots
 *    between), emails and UPI handles.
 * 2. Blocks the whole reply (swaps in a safe line) if it contains a
 *    never-say term: scarcity wording (counts are shared only as "N in the Den
 *    right now", read from the live site), losses, supplier/breeder talk, payment
 *    confirmation, refund approval, medicine/dosing, coupon-looking codes,
 *    discount-shop words.
 * 3. Fixes the brand name ("Discus Den" without "The" -> "The Discus Den").
 */

import { ANSWERS } from "./answers.ts";

/** 7+ digits with optional separators, e.g. +91 98xxx xxxxx, 98xxx-xxxxx. */
const PHONE_LIKE = /\+?\d(?:[\s\-.()]*\d){6,}/g;
const EMAIL_OR_UPI = /[a-z0-9._%+-]+@[a-z0-9.-]+/gi;

/** Reply is replaced outright if any of these match. */
const BLOCK_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "stock-count", re: /\b(only|just)\s+\d+\s+(left|remaining|available)\b/i },
  { name: "stock-count", re: /\b\d+\s+(left|remaining)\b/i },
  { name: "stock-count", re: /\b(in\s+stock\s*:?\s*\d+|stock\s+count|units?\s+left|pieces?\s+left)\b/i },
  { name: "stock-count", re: /\b(selling\s+fast|plenty\s+left|a\s+few\s+left|few\s+left)\b/i },
  { name: "mortality", re: /\b(mortality|died\s+in\s+(our|the)\s+tanks?|death\s+rate|losses)\b/i },
  { name: "supplier", re: /\b(supplier|breeder|source\s+farm|imported\s+from|we\s+source)\b/i },
  { name: "payment-confirm", re: /\b(payment|amount|money)\s+(is\s+|has\s+been\s+)?(received|confirmed|credited)\b/i },
  { name: "payment-confirm", re: /\b(received\s+your\s+payment|got\s+your\s+payment)\b/i },
  { name: "payment-details", re: /\b(upi\s*id|ifsc|account\s+number|a\/c\s*no)\b/i },
  { name: "refund-approval", re: /\brefund\s+(is\s+|has\s+been\s+)?(approved|processed|issued|done|initiated|sent)\b/i },
  { name: "refund-approval", re: /\b(approved?|processed|issued)\s+(your\s+|a\s+|the\s+)?refund\b/i },
  { name: "medical", re: /\b(medicine|medication|dosage|dose|mg\/l|antibiotic|metronidazole|praziquantel|formalin|malachite|methylene|salt\s+bath|treat\s+with)\b/i },
  { name: "coupon-code", re: /\b[A-Z]{3,}\d{1,4}\b/ },
  { name: "shop-words", re: /\b(cheap|cheapest|deals?|sale|hurry|best\s+price|offer\s+ends|grab)\b/i },
  { name: "shop-words", re: /!!!/ },
];

export type GuardResult = { text: string; blocked: string[]; stripped: number };

export function guardReply(input: string): GuardResult {
  let text = String(input ?? "");
  let stripped = 0;

  text = text.replace(EMAIL_OR_UPI, () => {
    stripped += 1;
    return "[removed]";
  });
  text = text.replace(PHONE_LIKE, () => {
    stripped += 1;
    return "[removed]";
  });

  const blocked = BLOCK_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
  if (blocked.length) {
    return { text: ANSWERS.unsure, blocked: [...new Set(blocked)], stripped };
  }

  // Brand: "Discus Den" must always be "The Discus Den"; "DD" never used.
  text = text.replace(/(^|[^A-Za-z])(?<!The\s)(?<!the\s)Discus Den/g, "$1The Discus Den");
  text = text.replace(/\bDD\b/g, "TDD");

  return { text, blocked: [], stripped };
}
