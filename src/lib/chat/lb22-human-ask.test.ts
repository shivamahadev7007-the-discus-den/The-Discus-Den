/**
 * LB-22 (High, Shiva 8 Oct 2:13 PM via Lea) + LB-21 part 2. Kiara's cases:
 * /workspace/the-discus-den/lb22-test-cases.md (updated 2:15 PM to Lea's spec).
 *  - EVERY human / owner / Shiva request asks for name + WhatsApp (not capped): confirm a
 *    valid name + number (masked 98xxxxxx12), the number by name, the name, or both.
 *  - The bot never says details were passed unless a valid number exists (this chat, or on
 *    file for a known returning customer).
 *  - Rotations: no human-request reply repeats word for word in a chat; from the 3rd request
 *    the LB-15 line is added in front of the ask, never instead of it.
 *  - Buy / order / pay questions trigger the first interest ask; "I am Arjun from Bangalore"
 *    gives the name and the city.
 *  - LB-21 part 2: no ask promises photos, videos, reservations or stock alerts.
 * Email scenarios (one email per chat, Lead / Visitor / Lead · returning) run on the memory
 * AND the PGlite store in lb19-chat-email.test.ts ("LB-22 · ..." suites).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ANSWERS, firmPushReply } from "./answers.ts";
import type { CatalogLoader } from "./catalog.ts";
import { introName, maskPhone, newChatFrom, respond, type ChatState } from "./engine.ts";
import { guardReply } from "./guard.ts";

const catalog: CatalogLoader = {
  strains: async () => [
    { name: "Blue Diamonds (Big)", size: "4.5 inch", price: "₹3,750", priceValue: 3750, available: true, description: "Electric blue." },
    { name: "Red Ninja Discus", size: "4 inch", price: "₹3,250", priceValue: 3250, available: true, description: "Red body." },
  ] as never,
  foods: async () => ({ frozen: [], pellets: [] }) as never,
};
async function run(messages: string[], start: ChatState | null = null) {
  let state = start;
  const out = [];
  for (const m of messages) {
    const r = await respond(state, m, { catalog });
    state = r.state;
    out.push(r);
  }
  return out;
}

/** G1: any "passed / shared / sent to Shiva" style claim. */
export const CLAIM = /\b(I've|I have)\s+(already\s+)?(passed|shared|sent)\b|\bpassed your (details|number)\b|\bShiva has your (details|number)\b|\bShiva will contact you\b/i;
/** G2 / LB-21 part 2: no ask promises any of these. */
const PROMISE = /reserve|stock|photo|video|book/i;
const ASK_RE = /name and WhatsApp number|What's your WhatsApp number|share your WhatsApp number|Type your WhatsApp number|best WhatsApp number for him|^I have you as |Just to check: is |Shiva can reach you as |Can you confirm /m;

function hasValidNumber(s: ChatState): boolean {
  return Boolean(s.lead.phone || (s.prior?.phone && !s.priorRejected));
}
function assertG1(r: { reply: string; state: ChatState }, ctx: string): void {
  if (CLAIM.test(r.reply)) assert.ok(hasValidNumber(r.state), `claim without a valid number: ${ctx} -> ${r.reply}`);
}
function assertSafe(text: string): void {
  assert.equal(guardReply(text).text, text, "the output guard must not need to rewrite it");
  assert.doesNotMatch(text, /\d(?:[\s-]*\d){6,}/, "never a full number");
  assert.doesNotMatch(text, /we don'?t deliver/i);
  assert.doesNotMatch(text, /\b(mortality|supplier|breeder)\b|gpay\s*(number|no)|upi\s*id/i);
  assert.doesNotMatch(text, /(^|[^e] )Discus Den/);
}

/** Every customer-facing LB-21 / LB-22 ask line (all rotation variants). */
function allAskLines(): string[] {
  const out: string[] = [ANSWERS.contactAskPhotos, ANSWERS.contactAskReserve, ANSWERS.contactAskTalk, ANSWERS.contactAskTalk2, ANSWERS.contactAskYes];
  for (let k = 0; k < 4; k++) {
    out.push(ANSWERS.humanAskBoth(k), ANSWERS.humanAskPhone("Arjun", k), ANSWERS.humanAskName(k), ANSWERS.humanConfirm("Arjun", "98xxxxxx12", k));
  }
  for (let k = 0; k < 3; k++) out.push(ANSWERS.humanConfirmYes("Arjun", k), ANSWERS.humanConfirmNo(k));
  return out;
}

describe("LB-22 · Shiva's live chat (2:03 PM), replayed exactly", () => {
  const SHIVA = [
    "Hey - how is it going. I am Arjun from Bangalore looking to buy discus.",
    "Sounds good - how to order and pay online!",
    "I see - thanks. Can you connect to the owner or a human agent?",
    "okay, thanks",
  ];
  it("fresh chat: T1 asks by name and keeps Arjun + Bangalore; T2 site steps (next turn, no re-ask); T3 asks Arjun's number, no 'passed'; T4 plain thanks", async () => {
    const out = await run(SHIVA);
    const r = out.map((o) => o.reply);
    assert.equal(out[0]!.state.lead.name, "Arjun");
    assert.equal(out[0]!.state.lead.city, "Bangalore");
    assert.ok(r[0]!.endsWith(`\n\n${ANSWERS.humanAskPhone("Arjun", 0)}`), r[0]);
    assert.ok(r[0]!.startsWith(ANSWERS.shipInStates), "Bangalore: we deliver by train, never a refusal");
    assert.match(r[1]!, /Current Stock.*Shopping Bag/s);
    assert.equal(ASK_RE.test(r[1]!), false, "the very next turn after ask 1 is not re-asked (interest rule)");
    assert.match(r[2]!, /\bArjun\b/);
    assert.match(r[2]!, /WhatsApp number/);
    assert.equal(r[2], ANSWERS.humanAskPhone("Arjun", 1));
    assert.doesNotMatch(r[2]!, CLAIM);
    assert.notEqual(r[2], ANSWERS.handoffAlreadyDone);
    assert.equal(r[3], ANSWERS.thanks, "'okay, thanks' is a plain thanks (not a 'yes')");
    for (const o of out) {
      assertG1(o, "Shiva replay");
      assertSafe(o.reply);
    }
  });
  it("Shiva's actual production state (a number on file from an earlier test chat): no false 'already passed'; the number is confirmed, masked", async () => {
    const prior = newChatFrom({ ...(await run(["Shiva 9845012312"])).at(-1)!.state });
    const out = await run(SHIVA, prior);
    const r = out.map((o) => o.reply);
    assert.ok(r[0]!.endsWith(ANSWERS.humanConfirm("Arjun", "98xxxxxx12", 0)), r[0]);
    assert.equal(r[2], ANSWERS.humanConfirm("Arjun", "98xxxxxx12", 1));
    assert.equal(r[3], ANSWERS.thanks, "'okay, thanks' is not taken as a yes to the confirmation");
    for (const o of out) assert.doesNotMatch(o.reply, /already passed/);
  });
  it("Kiara case 1 T4: a valid number after the T3 ask -> saved, closing line by name", async () => {
    const out = await run([...SHIVA.slice(0, 3), "My WhatsApp number is 9845012312"]);
    assert.equal(out[3]!.state.lead.phone, "+919845012312");
    assert.equal(out[3]!.reply, ANSWERS.handoffClose("Arjun"));
    assert.equal(out[3]!.closedNow, true);
  });
  it("Kiara case 1b: 'No thanks' after T3 -> 'No problem.', no claim; a later request asks again", async () => {
    const out = await run([...SHIVA.slice(0, 3), "No thanks", "Can I talk to Shiva?"]);
    assert.equal(out[3]!.reply, ANSWERS.handoffDeclined);
    assert.equal(out[4]!.reply, ANSWERS.humanAskPhone("Arjun", 2));
    for (const o of out) assertG1(o, "1b");
  });
});

describe("LB-22 · trigger phrasings (Kiara case 2): first message and after a price question", () => {
  const TRIGGERS = [
    "Can I talk to a human?",
    "I want to speak to the owner.",
    "Can I talk to Shiva?",
    "Is there a real person here?",
    "Please connect me to a human agent.",
    "Can the owner call me?",
    "I would like to speak with someone from the shop.",
    "connect me with the manager",
    "can I reach a real person",
    "I need to speak to a person",
    "let me talk to someone",
    "connect with staff please",
  ];
  for (const m of TRIGGERS) {
    it(`first message: '${m}' -> name + WhatsApp ask, no claim`, async () => {
      const [r] = await run([m]);
      assert.equal(r!.intent, "human_push", r!.reply);
      assert.equal(r!.reply, ANSWERS.humanAskBoth(0));
      assertG1(r!, m);
      assert.doesNotMatch(r!.reply, PROMISE);
    });
    it(`after a price question: '${m}' -> still the ask (interest + human asks are separate)`, async () => {
      const out = await run(["What is the price of Blue Diamond?", m]);
      assert.equal(out[1]!.intent, "human_push");
      assert.equal(out[1]!.reply, ANSWERS.humanAskBoth(0));
      assertG1(out[1]!, m);
    });
  }
  it("name known -> the number-only ask by name", async () => {
    const out = await run(["I am Arjun", "Can I talk to a human?"]);
    assert.equal(out[1]!.reply, ANSWERS.humanAskPhone("Arjun", 0));
  });
});

describe("LB-22 · no false trigger on the everyday word 'human' (Kiara case 8)", () => {
  for (const m of [
    "Are discus safe for children to handle?",
    "Is this hobby good for a human who is a beginner?",
    "is it safe for humans to touch the water?",
    "was it human error during shipping?",
    "are discus friendly with humans?",
    "who is the owner?",
  ]) {
    it(`'${m}' -> not a human request, no handoff claim`, async () => {
      const [r] = await run([m]);
      assert.notEqual(r!.intent, "human_push", r!.reply);
      assert.doesNotMatch(r!.reply, CLAIM);
      assert.equal(r!.state.handoff.active, false);
    });
  }
});

describe("LB-22 · never 'passed' without a valid number (Kiara case 3)", () => {
  it("3a: 'I am Arjun' then 'Connect me to the owner' -> asks for the number by name, no claim", async () => {
    const out = await run(["I am Arjun", "Connect me to the owner"]);
    assert.equal(out[0]!.state.lead.name, "Arjun");
    assert.equal(out[1]!.reply, ANSWERS.humanAskPhone("Arjun", 0));
    for (const o of out) assertG1(o, "3a");
  });
  it("3b: after the ask, '+91 98765 000' -> polite recheck, not saved, no claim", async () => {
    const out = await run(["Connect me to the owner", "+91 98765 000"]);
    assert.equal(out[1]!.reply, ANSWERS.phoneInvalid);
    assert.equal(out[1]!.state.lead.phone, undefined);
    for (const o of out) assertG1(o, "3b");
  });
  it("3c: after the ask, 'I will message later' -> no claim, carries on; a later request asks again", async () => {
    const out = await run(["Connect me to the owner", "I will message later", "price of blue diamond?", "Can I talk to the owner?"]);
    for (const o of out) assertG1(o, "3c");
    assert.equal(out[3]!.intent, "human_push");
    assert.match(out[3]!.reply, /name and WhatsApp number/);
  });
  it("a name only, an invalid number and a decline never give a claim, through many requests", async () => {
    const out = await run(["I am Arjun", "talk to a human", "98450 1234", "no", "connect me to Shiva", "no thanks", "speak to the owner", "real person please"]);
    for (const o of out) assertG1(o, "mixed");
    assert.equal(out.at(-1)!.state.lead.phone, undefined);
  });
});

describe("LB-22 · confirmation with a valid number (Kiara case 4 / 6)", () => {
  it("case 4: 'I am Priya, my number is 9123456780' then 'Can I talk to Shiva?' -> masked confirmation, no re-ask", async () => {
    const out = await run(["I am Priya, my number is 9123456780", "Can I talk to Shiva?"]);
    assert.equal(out[0]!.reply, ANSWERS.handoffClose("Priya"));
    assert.equal(out[1]!.reply, ANSWERS.humanConfirm("Priya", "91xxxxxx80", 0));
    assert.equal(out[1]!.reply, "I have you as Priya, 91xxxxxx80. Is that right? Shiva will get back to you on it.");
  });
  it("'yes' -> Shiva gets back on that number (a true claim now); 'no' -> asks for the right number, a new number closes", async () => {
    const yes = await run(["Ravi 9845012345", "talk to shiva", "yes"]);
    assert.equal(yes[2]!.reply, ANSWERS.humanConfirmYes("Ravi", 0));
    assert.equal(yes[2]!.state.confirmedOnFile, true);
    const no = await run(["Ravi 9845012345", "talk to shiva", "no", "it's 9845012399"]);
    assert.equal(no[2]!.reply, ANSWERS.humanConfirmNo(0));
    assert.equal(no[3]!.state.lead.phone, "+919845012399");
    assert.equal(no[3]!.reply, ANSWERS.handoffClose("Ravi"));
    for (const o of [...yes, ...no]) assertG1(o, "confirm");
  });
  it("case 6: returning customer (number on file) -> confirm; 'yes' closes as a true claim; 'no' never reuses the old number", async () => {
    const day1 = await run(["What is the price of Blue Diamond?", "I'm Ravi, 9845012345"]);
    const day2 = newChatFrom(day1.at(-1)!.state);
    const yes = await run(["Can I talk to the owner?", "yes"], day2);
    assert.equal(yes[0]!.reply, ANSWERS.humanConfirm("Ravi", "98xxxxxx45", 0));
    assert.equal(yes[1]!.reply, ANSWERS.humanConfirmYes("Ravi", 0));
    assert.equal(yes[1]!.closedNow, true, "the confirmation is the closing message of that chat");
    const no = await run(["Can I talk to the owner?", "no", "connect me to Shiva"], day2);
    assert.equal(no[1]!.reply, ANSWERS.humanConfirmNo(0));
    assert.equal(no[1]!.state.priorRejected, true);
    assert.equal(no[2]!.reply, ANSWERS.humanAskPhone("Ravi", 0), "the rejected number is not confirmed again");
    for (const o of [...yes, ...no]) assertG1(o, "case 6");
  });
  it("number first (no name), then a human request -> asks for the name; the name then closes", async () => {
    const out = await run(["9845012345", "Can I talk to Shiva?", "Meena"]);
    assert.equal(out[1]!.reply, ANSWERS.humanAskName(0));
    assert.equal(out[2]!.reply, ANSWERS.handoffClose("Meena"));
  });
  it("maskPhone shows the first 2 and last 2 digits only", () => {
    assert.equal(maskPhone("+919845012312"), "98xxxxxx12");
    assert.equal(maskPhone("+916123456789"), "61xxxxxx89");
  });
});

describe("LB-22 · uncapped, rotated, never verbatim (Kiara case 5)", () => {
  it("5a: ask, no, ask, no, ask (3rd: LB-15 line + ask), ask; never a claim; no two replies identical", async () => {
    const out = await run(["Can I talk to a human?", "No thanks", "I really want to speak to the owner", "No", "Connect me to Shiva", "Please let me talk to a human"]);
    const r = out.map((o) => o.reply);
    assert.equal(r[0], ANSWERS.humanAskBoth(0));
    assert.equal(r[2], ANSWERS.humanAskBoth(1));
    assert.equal(r[4], `${firmPushReply(0)}\n\n${ANSWERS.humanAskBoth(2)}`, "LB-15 line alongside the ask, never instead");
    assert.equal(r[5], `${firmPushReply(1)}\n\n${ANSWERS.humanAskBoth(3)}`);
    for (const i of [0, 2, 4, 5]) assert.match(r[i]!, /name and WhatsApp number/);
    for (const o of out) assertG1(o, "5a");
  });
  it("5b: interest asks stay capped at 2 (price -> ask 1; no; strain -> ask 2; no; delivery, visit -> none)", async () => {
    const out = await run(["What is the price of Blue Diamond?", "No thanks", "Which strains do you have?", "No", "How long does delivery take?", "Can I visit your shop?"]);
    assert.ok(out[0]!.reply.endsWith(ANSWERS.contactAskPhotos));
    assert.ok(out[2]!.reply.endsWith(ANSWERS.contactAskReserve));
    assert.equal(ASK_RE.test(out[4]!.reply) || out[4]!.reply.includes(ANSWERS.contactAskPhotos), false);
    assert.equal(out[5]!.reply.includes(ANSWERS.contactAskReserve) || out[5]!.reply.includes(ANSWERS.contactAskPhotos), false);
  });
  it("5c: after both interest asks, 'Can I talk to the owner?' still gets the ask", async () => {
    const out = await run(["What is the price of Blue Diamond?", "No thanks", "Which strains do you have?", "No", "Can I talk to the owner?"]);
    assert.equal(out[4]!.reply, ANSWERS.humanAskBoth(0));
  });
  for (const [label, start] of [
    ["neither known", [] as string[]],
    ["name known", ["I am Arjun"]],
    ["number known", ["9845012345"]],
    ["name + number known", ["Arjun 9845012312"]],
  ] as const) {
    it(`12 consecutive human requests (${label}): every reply asks / confirms, no two identical in the chat`, async () => {
      const pushes = ["talk to a human", "connect me to Shiva", "speak to the owner", "real person please", "can I talk to Shiva?", "let me speak to someone"];
      const msgs = Array.from({ length: 12 }, (_, i) => pushes[i % pushes.length]!);
      const out = (await run([...start, ...msgs])).slice(start.length);
      const r = out.map((o) => o.reply);
      assert.equal(new Set(r).size, r.length, "never word for word");
      for (let i = 0; i < r.length; i++) {
        assert.ok(ASK_RE.test(r[i]!) || [0, 1, 2, 3].some((k) => r[i]!.endsWith(ANSWERS.humanAskName(k))), `${i}: ${r[i]}`);
        if (i >= 2) assert.ok(r[i]!.startsWith(firmPushReply(i - 2)), `LB-15 line from the 3rd request: ${i}`);
        else assert.ok(!/Kindly place your requirement/.test(r[i]!));
        assertG1(out[i]!, label);
        assertSafe(r[i]!);
      }
    });
  }
});

describe("LB-22 · buy / order / pay intent triggers the first ask (item 2)", () => {
  for (const m of ["how to order and pay online!", "How do I buy discus?", "How do I pay?", "how to place order", "do I pay now?", "can I order on chat itself?"]) {
    it(`'${m}' -> the answer + ask 1`, async () => {
      const [r] = await run([m]);
      assert.ok(r!.reply.endsWith(`\n\n${ANSWERS.contactAskPhotos}`), `${r!.intent}: ${r!.reply}`);
      assertSafe(r!.reply);
    });
  }
  it("'I am Arjun from Bangalore looking to buy discus' -> delivery answer + ask by name", async () => {
    const [r] = await run(["I am Arjun from Bangalore looking to buy discus"]);
    assert.ok(r!.reply.endsWith(ANSWERS.humanAskPhone("Arjun", 0)), r!.reply);
  });
});

describe("LB-22 · volunteered name from 'I am X from Y' (pronoun / filler guards kept)", () => {
  const YES: Array<[string, string]> = [
    ["Hey - how is it going. I am Arjun from Bangalore looking to buy discus.", "Arjun"],
    ["I am Arjun", "Arjun"],
    ["I'm Priya, my number is 9123456780", "Priya"],
    ["my name is ravi kumar", "Ravi Kumar"],
    ["Myself Arjun from Pune", "Arjun"],
    ["this is meena from Coimbatore", "Meena"],
    ["hi, I am Mohammed Javed.", "Mohammed Javed"],
  ];
  for (const [m, n] of YES) it(`'${m}' -> ${n}`, () => assert.equal(introName(m), n));
  for (const m of [
    "I am looking to buy discus", "I am new to discus", "I'm from Chennai", "I am interested in blue diamond", "I am in Bangalore",
    "I'm fine", "I am a beginner", "You can reach me on 6123456789", "I am on 9845012345", "i am bangalore based", "this is great",
    "I am happy with the fish", "I'm confused.", "I am planning to set up a tank", "I am not sure", "I am ok", "i am arjun",
  ]) {
    it(`no name: '${m}'`, () => assert.equal(introName(m), null));
  }
});

describe("LB-21 part 2 / G2: asks promise only passing to Shiva", () => {
  it("no ask (any variant) matches /reserve|stock|photo|video|book/i; every ask passes the guard", () => {
    for (const a of allAskLines()) {
      assert.doesNotMatch(a, PROMISE, a);
      assertSafe(a);
    }
  });
  it("the first ask and the first talk reply only promise passing to Shiva; the 2nd ask reads differently from the 1st", () => {
    assert.equal(ANSWERS.contactAskPhotos, "May I have your name and WhatsApp number? I'll pass them to Shiva so he can get back to you personally.");
    assert.equal(ANSWERS.contactAskTalk, "Sure, I can pass your request to Shiva. May I have your name and WhatsApp number? He'll get back to you personally.");
    assert.notEqual(ANSWERS.contactAskPhotos, ANSWERS.contactAskReserve);
    assert.equal(ANSWERS.humanAskBoth(0), ANSWERS.contactAskTalk);
    assert.equal(ANSWERS.humanAskBoth(1), ANSWERS.contactAskTalk2);
  });
  it("no ask line claims the details were passed (only the closing / confirmed lines may, with a valid number)", () => {
    for (const a of allAskLines()) {
      if ([0, 1, 2].some((k) => a === ANSWERS.humanConfirmYes("Arjun", k))) continue;
      assert.doesNotMatch(a, CLAIM, a);
    }
  });
});
