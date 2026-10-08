/**
 * LB-19 (Shiva, 8 Oct 2026): name + WhatsApp capture in the engine.
 *  - after the first real-interest answer (price, strain, delivery, visit): ask 1 (photos / videos)
 *  - once more on a LATER interest turn (not the very next turn): ask 2 (Shiva gets back personally; LB-21); max 2
 *  - a number typed anywhere is saved (with a name next to it); invalid numbers get a polite recheck
 *  - "talk / connect to Shiva" gets the ask; LB-15's polite line only after a decline / both asks
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ANSWERS } from "./answers.ts";
import type { CatalogLoader } from "./catalog.ts";
import { isCourtesyOnly, looksLikeBadNumber, nameNearNumber, newChatFrom, respond, type ChatState } from "./engine.ts";
import { guardReply } from "./guard.ts";

const catalog: CatalogLoader = {
  strains: async () => [
    { name: "Blue Diamonds (Big)", size: "4.5 inch", price: "₹3,750", priceValue: 3750, available: true, description: "Electric blue." },
    { name: "Red Ninja Discus", size: "4 inch", price: "₹3,250", priceValue: 3250, available: true, description: "Red body." },
  ] as never,
  foods: async () => ({ frozen: [], pellets: [] }) as never,
};

/** LB-22 sweep (Kiara G1): no reply anywhere in this suite claims the details were passed without a valid number. */
const PASSED_CLAIM = /\b(I've|I have)\s+(already\s+)?(passed|shared|sent)\b|\bpassed your (details|number)\b|\bShiva has your (details|number)\b|\bShiva will contact you\b/i;
function assertNoFalseClaim(reply: string, s: ChatState, ctx: string): void {
  // LB-24: only a valid number typed IN THIS CHAT counts; no masked / partial number ever appears.
  if (PASSED_CLAIM.test(reply)) assert.ok(s.lead.phone, `'passed' claim without a valid number typed in this chat: ${ctx} -> ${reply}`);
  assert.doesNotMatch(reply, /\d{2}x{2,}\d{2}/i, `masked number in a reply: ${ctx}`);
}
async function run(messages: string[], start: ChatState | null = null) {
  let state = start;
  const out = [];
  for (const m of messages) {
    const r = await respond(state, m, { catalog });
    state = r.state;
    assertNoFalseClaim(r.reply, r.state, m);
    out.push(r);
  }
  return out;
}
const ASK1 = ANSWERS.contactAskPhotos;
const ASK2 = ANSWERS.contactAskReserve;
/** LB-22: any name / number ask, incl. the name-aware and confirmation variants. */
const ASK_RE = /name and WhatsApp number|What's your WhatsApp number|share your WhatsApp number|Type your WhatsApp number|best WhatsApp number for him|^I have you as |Just to check: is |Shiva can reach you as |Can you confirm /m;
const asks = (replies: string[]) =>
  replies.filter((r) => r.includes(ASK1) || r.includes(ASK2) || r.includes(ANSWERS.contactAskTalk) || r.includes(ANSWERS.contactAskTalk2) || ASK_RE.test(r)).length;

function assertNeverShare(text: string): void {
  assert.doesNotMatch(text, /\d(?:[\s-]*\d){6,}/, "no phone-like digits");
  assert.doesNotMatch(text, /we don'?t deliver/i);
  assert.doesNotMatch(text, /\b(mortality|supplier|breeder|gpay|upi)\b/i);
  assert.doesNotMatch(text, /\b(only|just)\s+\d+\s+left\b/i);
  assert.doesNotMatch(text, /(^|[^e] )Discus Den/);
  assert.equal(guardReply(text).text, text, "the output guard must not need to rewrite it");
}

describe("LB-19 · ask after the first real-interest question", () => {
  it("price -> answer + 'May I have your name and WhatsApp number? I'll pass them to Shiva...' (LB-21 part 2)", async () => {
    const [r] = await run(["price of blue diamond?"]);
    assert.ok(r!.reply.endsWith(`\n\n${ASK1}`), r!.reply);
    assert.equal(ASK1, "May I have your name and WhatsApp number? I'll pass them to Shiva so he can get back to you personally.");
    assert.equal(r!.state.contactAsk?.count, 1);
  });
  for (const m of ["do you ship to Kochi?", "how long does delivery take?", "red ninja price", "do you have blue diamond?"]) {
    it(`interest '${m}' carries ask 1`, async () => {
      const [r] = await run([m]);
      assert.ok(r!.reply.includes(ASK1), `${r!.intent}: ${r!.reply}`);
      assertNeverShare(r!.reply);
    });
  }
  for (const m of ["hi", "care tips", "what do discus eat?", "thanks", "is quarantine done?"]) {
    it(`no ask on a non-interest turn: '${m}'`, async () => {
      const [r] = await run([m]);
      assert.equal(asks([r!.reply]), 0, `${r!.intent}: ${r!.reply}`);
    });
  }
  // ---- LB-19 fix round (Kiara's report, item 6 / failure 4) ----
  for (const m of ["Which strains do you have?", "What strains are available?", "Is Red Ninja available?", "what fish do you have?"]) {
    it(`first STRAIN question gets the ask (in place of 'Want me to narrow it down...'): '${m}'`, async () => {
      const [r] = await run([m]);
      assert.ok(r!.reply.endsWith(`\n\n${ASK1}`), `${r!.intent}: ${r!.reply}`);
      assert.doesNotMatch(r!.reply, /narrow it down/, "one question at a time");
      assert.equal(r!.state.pendingOffer, null);
      assertNeverShare(r!.reply);
    });
  }
  it("a strain that isn't listed: the ask replaces 'Shall I ask him?' (the STRAIN NOT LISTED flag stays)", async () => {
    const [r] = await run(["Do you have pigeon blood discus?"]);
    assert.ok(r!.reply.startsWith("That one isn't on our available page right now."), r!.reply);
    assert.ok(r!.reply.endsWith(ASK1));
    assert.doesNotMatch(r!.reply, /Shall I ask him/);
    assert.ok(r!.state.flags.some((f) => f.startsWith("STRAIN NOT LISTED")));
  });
  for (const m of ["Can I visit your shop?", "Can I visit the store?", "What's your address and timings?", "Chennai la pickup irukka?"]) {
    it(`first VISIT / pickup question gets the name + WhatsApp ask, not 'Shall I pass your details?': '${m}'`, async () => {
      const [r] = await run([m]);
      assert.ok(r!.reply.endsWith(`\n\n${ASK1}`), `${r!.intent}: ${r!.reply}`);
      assert.doesNotMatch(r!.reply, /Shall I pass your details|Want me to pass your details/);
      assert.equal(r!.state.contactAsk?.count, 1);
    });
  }
  it("visit ask -> name + number -> closing message", async () => {
    const out = await run(["Can I visit your shop?", "Ravi 9876500001"]);
    assert.equal(out[1]!.reply, ANSWERS.handoffClose("Ravi"));
    assert.equal(out[1]!.closedNow, true);
  });
  it("visit ask -> 'yes' -> the guided visit handoff (LB-9 flow) still opens", async () => {
    const out = await run(["Can I visit your shop?", "yes"]);
    assert.equal(out[1]!.reply, ANSWERS.handoffAskName);
    assert.equal(out[1]!.state.handoff.active, true);
  });
  it("visit ask -> 'no thanks' -> 'No problem.' (counts as a decline)", async () => {
    const out = await run(["Can I visit your shop?", "no thanks"]);
    assert.equal(out[1]!.reply, ANSWERS.handoffDeclined);
    assert.equal(out[1]!.state.contactAsk?.declined, true);
  });
  it("visit after both asks are used: the old visit offer is back (no third ask)", async () => {
    const out = await run(["price of blue diamond?", "hmm", "do you ship to Kochi?", "Can I visit your shop?"]);
    assert.equal(asks(out.map((o) => o.reply)), 2);
    assert.equal(out[3]!.reply, ANSWERS.visit);
  });
});

describe("LB-19 · ask once more later, different reason, max 2", () => {
  it("ignored: no re-ask on the very next turn; ask 2 (get back personally) on a later interest turn; then never again", async () => {
    const out = await run(["price of blue diamond?", "do you ship to Kochi?", "red ninja price", "how long does delivery take?", "do you have blue diamond?", "price of red ninja?"]);
    const r = out.map((o) => o.reply);
    assert.ok(r[0]!.endsWith(ASK1));
    assert.ok(!r[1]!.includes(ASK1) && !r[1]!.includes(ASK2), "not the very next turn");
    assert.ok(r[2]!.endsWith(ASK2), r[2]);
    assert.equal(asks(r.slice(3)), 0, "max 2 asks per chat");
    assert.equal(out.at(-1)!.state.contactAsk?.count, 2);
    assert.notEqual(ASK1, ASK2);
    // LB-21 (Shiva, 8 Oct): ask 2 only promises Shiva gets back; never a reservation / stock alert.
    assert.ok(ASK2.includes("get back to you personally"), ASK2);
    assert.doesNotMatch(ASK2, /reserve|stock alert|new stock|book/i);
  });
  it("LB-21: neither later ask (ask 2 / talk ask 2) promises a reservation or stock", () => {
    for (const a of [ANSWERS.contactAskReserve, ANSWERS.contactAskTalk2]) {
      assert.doesNotMatch(a, /reserve|stock/i, a);
      assert.ok(a.includes("get back to you personally"), a);
    }
  });
  it("declined: 'no thanks' -> 'No problem.'; one later re-ask; then stop", async () => {
    const out = await run(["price of blue diamond?", "no thanks", "do you ship to Kochi?", "red ninja price", "no", "how long does delivery take?"]);
    assert.equal(out[1]!.reply, ANSWERS.handoffDeclined);
    assert.equal(out[1]!.state.contactAsk?.declined, true);
    assert.ok(out[2]!.reply.endsWith(ASK2) || out[3]!.reply.endsWith(ASK2));
    assert.equal(asks(out.slice(4).map((o) => o.reply)), 0);
    for (const o of out) assertNeverShare(o.reply);
  });
  it("'yes' to the ask -> 'Please type your name and WhatsApp number here.'", async () => {
    const out = await run(["price of blue diamond?", "yes"]);
    assert.equal(out[1]!.reply, ANSWERS.contactAskYes);
  });
  it("a name alone after the ask -> asks for the number", async () => {
    const out = await run(["price of blue diamond?", "Ravi"]);
    assert.equal(out[1]!.reply, ANSWERS.handoffAskPhone("Ravi"));
    assert.equal(out[1]!.state.lead.name, "Ravi");
  });
});

describe("LB-19 · a number typed anywhere is saved", () => {
  const VALID: Array<[string, string, string | undefined]> = [
    ["9845012345", "+919845012345", undefined],
    ["+91 98450 12345", "+919845012345", undefined],
    ["91-98450-12345", "+919845012345", undefined],
    ["098450 12345", "+919845012345", undefined],
    ["Ravi 9845012345", "+919845012345", "Ravi"],
    ["I'm Ravi, my number is 98450 12345", "+919845012345", "Ravi"],
    ["9845012345 Priya", "+919845012345", "Priya"],
    ["name: Arun Kumar, whatsapp 7012345678", "+917012345678", "Arun Kumar"],
    ["this is Meena from Coimbatore, 6382012345", "+916382012345", "Meena"],
    ["call me on 8012345678", "+918012345678", undefined],
    // LB-19 fix round (Kiara #6): the words around a number are not a name.
    ["You can reach me on 6123456789", "+916123456789", undefined],
    ["you can call me at 9876500001", "+919876500001", undefined],
    ["feel free to whatsapp me on 9876500001", "+919876500001", undefined],
    ["I am on 9876500001", "+919876500001", undefined],
    ["my whatsapp number is 9876500001", "+919876500001", undefined],
    ["reach me at 9876500001 - Meena", "+919876500001", "Meena"],
    ["Meena here, 9876500020", "+919876500020", "Meena"],
    ["+91-98765-00001", "+919876500001", undefined],
    ["919876500001", "+919876500001", undefined],
    ["0 98765 00001", "+919876500001", undefined],
  ];
  for (const [msg, phone, name] of VALID) {
    it(`'${msg}' -> phone ${phone}${name ? `, name ${name}` : ""}`, async () => {
      const [r] = await run([msg]);
      assert.equal(r!.state.lead.phone, phone);
      assert.equal(r!.state.lead.name, name);
      assert.equal(r!.phoneCapturedNow, true);
      if (name) {
        assert.equal(r!.reply, ANSWERS.handoffClose(name), "closing message (the chat ends)");
        assert.equal(r!.closedNow, true);
      } else {
        assert.equal(r!.reply, ANSWERS.contactNeedName);
        assert.equal(r!.closedNow, false);
      }
      assert.doesNotMatch(r!.reply, /\d{5}/, "never echoes the number");
    });
  }
  it("number first, then the name -> closing message", async () => {
    const out = await run(["9845012345", "Ravi"]);
    assert.equal(out[1]!.reply, ANSWERS.handoffClose("Ravi"));
    assert.equal(out[1]!.closedNow, true);
    assert.equal(out[1]!.state.completed, true);
  });
  it("a number inside another question: the answer comes first, then the acknowledgement", async () => {
    const [r] = await run(["price of blue diamond? my number 9845012345"]);
    assert.match(r!.reply, /Blue Diamonds/);
    assert.ok(r!.reply.endsWith(ANSWERS.contactNoted), r!.reply);
    assert.equal(r!.state.lead.phone, "+919845012345");
  });
  it("dead fish + number: the loss net still wins (its DOA handoff carries on with the number saved)", async () => {
    const [r] = await run(["my fish died after delivery, call me 9845012345"]);
    assert.equal(r!.intent, "loss_safety_net");
    assert.equal(r!.state.lead.phone, "+919845012345");
  });
  it("a number with a talk-to-Shiva push is the answer to the push", async () => {
    const [r] = await run(["connect me to Shiva, I'm Ravi 9845012345"]);
    assert.equal(r!.reply, ANSWERS.handoffClose("Ravi"));
  });
  it("after the number is saved, no more asks", async () => {
    const out = await run(["9845012345", "price of blue diamond?", "do you ship to Kochi?", "red ninja price"]);
    assert.equal(asks(out.slice(1).map((o) => o.reply)), 0);
  });
});

describe("LB-19 · human check: invalid numbers get a polite recheck, never a Lead", () => {
  // LB-19 fix round (Kiara #5): a country code + a short number is never read as a mobile
  // ("+91 98765 000" used to be saved as +919198765000).
  for (const m of ["12345 67890", "98450 1234", "9876543210", "my number is 5551234567", "+91 12345 678901", "99999 99999",
    "+91 98765 000", "91 98765 000", "+91 98765", "+9198765000", "98765 0001", "5876500037", "98765000381", "+1 415 555 0101"]) {
    it(`'${m}' -> recheck`, async () => {
      const [r] = await run([m]);
      assert.equal(r!.reply, ANSWERS.phoneInvalid, r!.intent);
      assert.equal(r!.state.lead.phone, undefined);
      assert.equal(r!.state.badNumbers, 1);
      assertNeverShare(r!.reply);
    });
  }
  it("Kiara's repro: price question, then '+91 98765 000' -> recheck, nothing saved, never a Lead", async () => {
    const out = await run(["What is the price of Blue Diamond?", "+91 98765 000", "I'm Ravi"]);
    assert.equal(out[1]!.reply, ANSWERS.phoneInvalid);
    assert.equal(out[2]!.state.lead.phone, undefined);
    assert.equal(out.some((o) => o.closedNow), false);
  });
  it("Kiara's repro: 'You can reach me on 6123456789' -> number saved, then 'What name should he use…'; the name comes next", async () => {
    const out = await run(["What is the price of Blue Diamond?", "You can reach me on 6123456789", "Ravi"]);
    assert.equal(out[1]!.reply, ANSWERS.contactNeedName);
    assert.equal(out[1]!.state.lead.name, undefined);
    assert.equal(out[2]!.reply, ANSWERS.handoffClose("Ravi"));
  });
  it("recheck then a valid number -> saved", async () => {
    const out = await run(["98450 1234", "Ravi 98450 12345"]);
    assert.equal(out[1]!.state.lead.phone, "+919845012345");
  });
  for (const m of ["₹3,250 is the price?", "I need 10 fish", "tank is 200 litres", "3/10/2026 delivery?", "4.5 inch blue diamond"]) {
    it(`not a number attempt: '${m}'`, () => assert.equal(looksLikeBadNumber(m), false));
  }
});

describe("LB-19 · talk / connect to Shiva -> the ask; LB-15 after a decline", () => {
  it("first push -> name + WhatsApp ask (not the LB-14 self-explanatory line)", async () => {
    const [r] = await run(["Connect to Shiva"]);
    assert.equal(r!.reply, ANSWERS.contactAskTalk);
    assert.doesNotMatch(r!.reply, /self-explanatory/);
    assert.equal(r!.state.handoff.active, false);
  });
  // LB-22 + LB-25 (Shiva, 8 Oct): human requests are never capped, a decline included; from the
  // 3rd request the ask carries the "Shiva will get back to you personally" note (no LB-15 line).
  it("push, 'no', push -> still the ask after the decline (rotated); from the 3rd push the composed ask + note", async () => {
    const out = await run(["talk to shiva", "no", "talk to shiva", "connect me to the owner", "put me through"]);
    assert.equal(out[0]!.reply, ANSWERS.contactAskTalk);
    assert.equal(out[1]!.reply, ANSWERS.handoffDeclined);
    assert.equal(out[2]!.reply, ANSWERS.contactAskTalk2);
    assert.equal(out[3]!.reply, ANSWERS.humanAskLater("both", 0));
    assert.equal(out[4]!.reply, ANSWERS.humanAskLater("both", 1));
    for (const o of out) assert.doesNotMatch(o.reply, /Kindly place your requirement|fill in the form/);
  });
  it("three pushes without a number: ask, ask, composed ask + 'Shiva will get back to you personally'", async () => {
    const out = await run(["talk to shiva", "talk to shiva", "talk to shiva"]);
    assert.deepEqual(out.map((o) => o.reply), [ANSWERS.contactAskTalk, ANSWERS.contactAskTalk2, ANSWERS.humanAskLater("both", 0)]);
    assert.match(out[2]!.reply, /Shiva will get back to you personally/);
  });
  it("'give me Shiva's number' -> the ask, never a number", async () => {
    const [r] = await run(["give me Shiva's number"]);
    assert.equal(r!.reply, ANSWERS.contactAskTalk);
    assertNeverShare(r!.reply);
  });
  it("LB-25: push after name + number were typed in this chat -> 'passed' (rotated), no re-ask", async () => {
    const out = await run(["Ravi 9845012345", "talk to shiva", "talk to shiva"]);
    assert.equal(out[1]!.reply, ANSWERS.humanPassed("Ravi", 0));
    assert.equal(out[2]!.reply, ANSWERS.humanPassed("Ravi", 1));
  });
});

describe("LB-19 · new chat on the same browser session", () => {
  it("LB-24: newChatFrom resets per-chat counters and carries NO name / number / city (only one-way keys)", async () => {
    const [r] = await run(["I'm Ravi from Kochi, 9845012345"]);
    const fresh = newChatFrom(r!.state);
    assert.deepEqual(fresh.lead, {});
    assert.equal(fresh.completed, false);
    assert.equal(fresh.contactAsk, undefined);
    assert.equal(JSON.stringify(fresh).includes("9845012345"), false);
    assert.equal(JSON.stringify(fresh).includes("Ravi"), false);
    assert.equal(fresh.onFile?.length, 1);
    const out = await run(["price of blue diamond?", "talk to shiva"], fresh);
    // Exactly what a fresh visitor gets.
    const cold = await run(["price of blue diamond?", "talk to shiva"]);
    assert.deepEqual(out.map((o) => o.reply), cold.map((o) => o.reply));
  });
  it("'thanks' after the closing message is a plain thanks (no 'Discus fish or frozen foods?' re-ask)", async () => {
    const out = await run(["What is the price of Blue Diamond?", "I'm Ravi Kumar, 9876500001", "thanks"]);
    assert.equal(out[2]!.reply, ANSWERS.thanks);
    assert.doesNotMatch(out[2]!.reply, /frozen foods/);
  });
  it("isCourtesyOnly: thanks / bye / ok, not questions", () => {
    for (const t of ["thanks", "thank you", "ok thanks", "bye", "ok", "great thanks", "thx", "ok bye", "nandri"]) assert.ok(isCourtesyOnly(t), t);
    for (const t of ["thanks, what about red ninja price?", "ok when will it ship", "hi", "price?", "talk to shiva"]) assert.ok(!isCourtesyOnly(t), t);
  });
  it("nameNearNumber ignores filler words and places", () => {
    assert.equal(nameNearNumber("call me on 9845012345"), null);
    assert.equal(nameNearNumber("my whatsapp is 9845012345 please"), null);
    assert.equal(nameNearNumber("Chennai 9845012345"), null);
    assert.equal(nameNearNumber("blue diamond 9845012345"), null);
    assert.equal(nameNearNumber("Ravi Kumar 9845012345"), "Ravi Kumar");
  });
});
