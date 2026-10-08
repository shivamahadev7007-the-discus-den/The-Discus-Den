/**
 * LB-19 (Shiva, 8 Oct 2026): name + WhatsApp capture in the engine.
 *  - after the first real-interest answer (price, strain, delivery, visit): ask 1 (photos / videos)
 *  - once more on a LATER interest turn (not the very next turn): ask 2 (reserve / stock alert); max 2
 *  - a number typed anywhere is saved (with a name next to it); invalid numbers get a polite recheck
 *  - "talk / connect to Shiva" gets the ask; LB-15's polite line only after a decline / both asks
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ANSWERS, firmPushReply } from "./answers.ts";
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
const ASK1 = ANSWERS.contactAskPhotos;
const ASK2 = ANSWERS.contactAskReserve;
const asks = (replies: string[]) => replies.filter((r) => r.includes(ASK1) || r.includes(ASK2) || r.includes(ANSWERS.contactAskTalk) || r.includes(ANSWERS.contactAskTalk2)).length;

function assertNeverShare(text: string): void {
  assert.doesNotMatch(text, /\d(?:[\s-]*\d){6,}/, "no phone-like digits");
  assert.doesNotMatch(text, /we don'?t deliver/i);
  assert.doesNotMatch(text, /\b(mortality|supplier|breeder|gpay|upi)\b/i);
  assert.doesNotMatch(text, /\b(only|just)\s+\d+\s+left\b/i);
  assert.doesNotMatch(text, /(^|[^e] )Discus Den/);
  assert.equal(guardReply(text).text, text, "the output guard must not need to rewrite it");
}

describe("LB-19 · ask after the first real-interest question", () => {
  it("price -> answer + 'May I have your name and WhatsApp number? Shiva can send you photos and videos...'", async () => {
    const [r] = await run(["price of blue diamond?"]);
    assert.ok(r!.reply.endsWith(`\n\n${ASK1}`), r!.reply);
    assert.equal(ASK1, "May I have your name and WhatsApp number? Shiva can send you photos and videos of the actual fish.");
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
  it("store visit offers the handoff itself (no second ask stacked on it)", async () => {
    const [r] = await run(["Can I visit the store?"]);
    assert.equal(r!.state.pendingOffer, "handoff");
    assert.equal(asks([r!.reply]), 0);
  });
});

describe("LB-19 · ask once more later, different reason, max 2", () => {
  it("ignored: no re-ask on the very next turn; ask 2 (reserve / stock alert) on a later interest turn; then never again", async () => {
    const out = await run(["price of blue diamond?", "do you ship to Kochi?", "red ninja price", "how long does delivery take?", "do you have blue diamond?", "price of red ninja?"]);
    const r = out.map((o) => o.reply);
    assert.ok(r[0]!.endsWith(ASK1));
    assert.ok(!r[1]!.includes(ASK1) && !r[1]!.includes(ASK2), "not the very next turn");
    assert.ok(r[2]!.endsWith(ASK2), r[2]);
    assert.equal(asks(r.slice(3)), 0, "max 2 asks per chat");
    assert.equal(out.at(-1)!.state.contactAsk?.count, 2);
    assert.notEqual(ASK1, ASK2);
    assert.match(ASK2, /reserve|new stock/);
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
  for (const m of ["12345 67890", "98450 1234", "9876543210", "my number is 5551234567", "+91 12345 678901", "99999 99999"]) {
    it(`'${m}' -> recheck`, async () => {
      const [r] = await run([m]);
      assert.equal(r!.reply, ANSWERS.phoneInvalid, r!.intent);
      assert.equal(r!.state.lead.phone, undefined);
      assert.equal(r!.state.badNumbers, 1);
      assertNeverShare(r!.reply);
    });
  }
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
  it("push, 'no', push -> LB-15 polite line right after the decline (rotated, never identical twice)", async () => {
    const out = await run(["talk to shiva", "no", "talk to shiva", "connect me to the owner", "put me through"]);
    assert.equal(out[0]!.reply, ANSWERS.contactAskTalk);
    assert.equal(out[1]!.reply, ANSWERS.handoffDeclined);
    assert.equal(out[2]!.reply, ANSWERS.humanPushFirm);
    assert.equal(out[3]!.reply, firmPushReply(1));
    assert.equal(out[4]!.reply, firmPushReply(2));
  });
  it("two asks without a number, then LB-15", async () => {
    const out = await run(["talk to shiva", "talk to shiva", "talk to shiva"]);
    assert.deepEqual(out.map((o) => o.reply), [ANSWERS.contactAskTalk, ANSWERS.contactAskTalk2, ANSWERS.humanPushFirm]);
  });
  it("'give me Shiva's number' -> the ask, never a number", async () => {
    const [r] = await run(["give me Shiva's number"]);
    assert.equal(r!.reply, ANSWERS.contactAskTalk);
    assertNeverShare(r!.reply);
  });
  it("push after the number was given -> 'already passed', then LB-15 rotation", async () => {
    const out = await run(["Ravi 9845012345", "talk to shiva", "talk to shiva"]);
    assert.equal(out[1]!.reply, ANSWERS.handoffAlreadyDone);
    assert.equal(out[2]!.reply, ANSWERS.humanPushFirm);
  });
});

describe("LB-19 · new chat on the same browser session", () => {
  it("newChatFrom resets per-chat counters and carries known details as prior", async () => {
    const [r] = await run(["Ravi 9845012345"]);
    const fresh = newChatFrom(r!.state);
    assert.equal(fresh.lead.phone, undefined);
    assert.equal(fresh.completed, false);
    assert.equal(fresh.contactAsk, undefined);
    assert.deepEqual(fresh.prior, { name: "Ravi", phone: "+919845012345" });
    const out = await run(["price of blue diamond?", "talk to shiva"], fresh);
    assert.equal(asks([out[0]!.reply]), 0, "no ask for a number we already have");
    assert.equal(out[1]!.reply, ANSWERS.handoffAlreadyDone);
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
