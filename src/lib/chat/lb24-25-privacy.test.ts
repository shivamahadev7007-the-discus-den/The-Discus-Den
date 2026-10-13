/**
 * LB-24 (privacy, MUST) + LB-25 (Shiva's rule on human requests), Shiva via Lea 8 Oct 2:44 PM.
 * Kiara's cases: /workspace/the-discus-den/lb24-25-test-cases.md (C10 dropped with LB-20).
 *  - Only details typed IN THIS CHAT are ever used; nothing from an earlier chat on the same
 *    browser (shared device) is shown, masked or not, or changes a reply.
 *  - "What is my phone number?" -> privacy reply (never reveals), rotated.
 *  - Human requests: from the 3rd, the ask carries "Shiva will get back to you personally"
 *    (LB-15 line removed from this path); after a valid name + number typed in this chat,
 *    "passed" (no re-ask); no reply ever repeats word for word in a chat.
 * Email scenarios (C1 / C2 / C5, same / different number) on memory AND PGlite stores:
 * lb19-chat-email.test.ts ("LB-24 · ..." suites).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ANSWERS, composeRot } from "./answers.ts";
import type { CatalogLoader } from "./catalog.ts";
import { newChatFrom, respond, type ChatState } from "./engine.ts";
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
async function earlierChat(msgs: string[]): Promise<ChatState> {
  return newChatFrom((await run(msgs)).at(-1)!.state);
}
const CLAIM = /\b(I've|I have)\s+(already\s+)?(passed|shared|sent)\b|\bpassed your (details|number)\b|\bShiva (has|already has) your (details|number)\b|are with Shiva/i;
const ASK_RE = /WhatsApp number|your name|name should|name is all|name to pass|name Shiva|name whenever/i;
const MASKED = /\d{2}\s*x{2,}\s*\d{2}/i;
function sentences(reply: string): string[] {
  return reply.split(/(?<=[.?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
}
function assertClean(reply: string, old: RegExp): void {
  assert.doesNotMatch(reply, old, `earlier chat's details leaked: ${reply}`);
  assert.doesNotMatch(reply, MASKED);
  assert.doesNotMatch(reply, /I have you as|on file|earlier chat|already passed/i);
  assert.equal(guardReply(reply).text, reply);
}

describe("LB-24 · shared device: an earlier chat's name / number never shows or shapes a reply", () => {
  const RAVI = /Ravi|9845012345|98450|12345|98xx/;
  it("C1 chat 2: Meena asks for the owner -> fresh ask; 'What is my phone number?' -> privacy reply; her number -> saved, passed", async () => {
    const day2 = await earlierChat(["I am Ravi Kumar, my WhatsApp is 9845012345"]);
    assert.deepEqual(day2.lead, {});
    assert.ok(!JSON.stringify(day2).includes("Ravi") && !JSON.stringify(day2).includes("9845012345"), "no old details in the engine state");
    const out = await run(["Hi, I am Meena. Can I talk to the owner?", "What is my phone number?", "My number is 9123456780"], day2);
    // LB-28: greeted by name first (this chat's name), then the number ask by name.
    assert.equal(out[0]!.reply, `${ANSWERS.greetIntro("Hi", "Meena", false, 0)}\n\n${ANSWERS.humanAskPhone("Meena", 0)}`, "asks this chat's name for the number");
    assert.equal(out[1]!.reply, ANSWERS.privacyNoDetails(0));
    assert.match(out[1]!.reply, /can't show|not able to display/);
    assert.equal(out[2]!.reply, ANSWERS.handoffClose("Meena"));
    assert.equal(out[2]!.state.lead.phone, "+919123456780");
    for (const o of out) assertClean(o.reply, RAVI);
  });
  it("C2: same, but 'No thanks' -> no claim; nothing from Ravi", async () => {
    const day2 = await earlierChat(["I am Ravi Kumar, my WhatsApp is 9845012345"]);
    const out = await run(["Hi, I am Meena. Can I talk to the owner?", "No thanks"], day2);
    assert.equal(out[1]!.reply, ANSWERS.handoffDeclined);
    for (const o of out) {
      assertClean(o.reply, RAVI);
      assert.doesNotMatch(o.reply, CLAIM);
    }
  });
  it("C3: Shiva's Arjun replay with an old number on file -> identical to a fresh chat; T4 number -> passed", async () => {
    const msgs = ["I am Arjun from Bangalore looking to buy discus", "how to order and pay online!", "Can you connect to the owner or a human agent?", "9845012312"];
    const withOld = await run(msgs, await earlierChat(["Arjun 9845012345"]));
    const fresh = await run(msgs);
    assert.deepEqual(withOld.map((o) => o.reply), fresh.map((o) => o.reply));
    assert.equal(withOld[2]!.reply, ANSWERS.humanAskPhone("Arjun", 1));
    assert.equal(withOld[3]!.reply, ANSWERS.handoffClose("Arjun"));
    for (const o of withOld.slice(0, 3)) assertClean(o.reply, /9845012345|98xx/);
  });
  it("C4: 'What is my phone number?' (and variants) with a number on file but none typed here -> privacy reply, rotated, never repeated", async () => {
    const msgs = ["What is my phone number?", "what's my name?", "what number do you have for me?", "show me my details"];
    const out = await run(msgs, await earlierChat(["I'm Ravi, 9845012345"]));
    out.forEach((o, i) => {
      assert.equal(o.reply, ANSWERS.privacyNoDetails(i), msgs[i]);
      assert.equal(o.intent, "privacy_details");
      assertClean(o.reply, /Ravi|9845012345/);
    });
    assert.equal(new Set(out.map((o) => o.reply)).size, out.length);
  });
  it("C4: with a number typed in this chat -> still never echoes it (no confirmation of digits), says it's with Shiva", async () => {
    const out = await run(["I'm Priya, 9123456780", "What is my phone number?", "what number do you have?"]);
    assert.equal(out[1]!.reply, ANSWERS.privacyHasDetails(0));
    assert.equal(out[2]!.reply, ANSWERS.privacyHasDetails(1));
    for (const o of out.slice(1)) assert.doesNotMatch(o.reply, /9123|6780|Priya/);
  });
  it("every new chat's engine state starts with no name / number / city; only one-way keys of earlier numbers", async () => {
    const s = await earlierChat(["I'm Ravi from Kochi, 9845012345"]);
    assert.deepEqual(s.lead, {});
    assert.deepEqual(Object.keys(s).filter((k) => /prior|confirm/i.test(k)), []);
    assert.match(s.onFile![0]!, /^[0-9a-f]{32}$/);
    // legacy LB-19 session rows (saved with `prior` before LB-24): no details carried either
    const legacy = newChatFrom({ ...s, prior: { name: "Ravi", phone: "+919845012345", city: "Kochi" } } as ChatState);
    assert.deepEqual(legacy.lead, {});
    assert.ok(!JSON.stringify(legacy).match(/Ravi|9845012345|Kochi/));
  });
  it("interest asks for a returning session are exactly a fresh visitor's (no skipped asks, no names)", async () => {
    const msgs = ["price of blue diamond?", "no", "do you deliver to Chennai?", "can I visit?", "thanks"];
    const back = await run(msgs, await earlierChat(["I'm Ravi, 9845012345"]));
    const cold = await run(msgs);
    assert.deepEqual(back.map((o) => o.reply), cold.map((o) => o.reply));
  });
});

describe("LB-25 · repeated human requests", () => {
  const SIX = ["Can I talk to a human?", "I want to speak to the owner.", "Can I talk to Shiva?", "Is there a real person here?", "Please connect me to a human agent.", "I would like to speak with someone from the shop."];
  it("C6: six requests, each declined -> every reply asks for name + number; from the 3rd the 'gets back personally' note; replies and ask sentences unique", async () => {
    const msgs = SIX.flatMap((m) => [m, "No thanks"]);
    const out = await run(msgs);
    const asks = out.filter((_, i) => i % 2 === 0).map((o) => o.reply);
    asks.forEach((r, i) => {
      assert.match(r, /name (and|with) (a |the best |your )?WhatsApp number|name and WhatsApp number/, `${i}: ${r}`);
      if (i >= 2) assert.match(r, /Shiva[^.]*get back to you personally/, `note from the 3rd: ${r}`);
      assert.doesNotMatch(r, /Kindly place your requirement|fill in the form|Place request/);
      assert.doesNotMatch(r, CLAIM);
    });
    const all = out.map((o) => o.reply);
    assert.equal(new Set(all).size, all.length, "no reply repeats word for word (declines included)");
    const askSentences = asks.flatMap(sentences).filter((x) => ASK_RE.test(x));
    assert.equal(new Set(askSentences).size, askSentences.length, `ask sentences unique: ${askSentences.join(" | ")}`);
  });
  it("3rd request -> the composed ask with 'Shiva will get back to you personally', no LB-15 line", async () => {
    const out = await run(["talk to shiva", "talk to shiva", "talk to shiva"]);
    assert.equal(out[2]!.reply, ANSWERS.humanAskLater("both", 0));
    assert.equal(out[2]!.reply, "Could you type your name and WhatsApp number here? Shiva will get back to you personally.");
  });
  it("C7: details first, then 3 requests -> each says passed, no re-ask, no two identical", async () => {
    const out = await run(["I am Priya, my number is 9123456780", ...SIX.slice(0, 3)]);
    const r = out.slice(1).map((o) => o.reply);
    r.forEach((x, k) => {
      assert.equal(x, ANSWERS.humanPassed("Priya", k));
      assert.match(x, CLAIM);
      assert.match(x, /get back to you personally/);
      assert.doesNotMatch(x, /WhatsApp number\?|your name\?|type your|share your/i);
    });
    assert.equal(new Set(r).size, 3);
  });
  it("C8: details given after the 3rd request, then a 4th -> passed, no re-ask", async () => {
    const out = await run([SIX[0]!, SIX[1]!, SIX[2]!, "I'm Priya, 9123456780", SIX[3]!]);
    assert.equal(out[3]!.reply, ANSWERS.handoffClose("Priya"));
    assert.equal(out[4]!.reply, ANSWERS.humanPassed("Priya", 0));
  });
  it("name only / number only: keeps asking for the missing piece (with the note from the 3rd), never 'passed'", async () => {
    const nameOnly = await run(["I am Arjun", ...SIX.slice(0, 4)]);
    assert.deepEqual(nameOnly.slice(1).map((o) => o.reply), [ANSWERS.humanAskPhone("Arjun", 0), ANSWERS.humanAskPhone("Arjun", 1), ANSWERS.humanAskLater("phone", 0, "Arjun"), ANSWERS.humanAskLater("phone", 1, "Arjun")]);
    const numOnly = await run(["9845012345", ...SIX.slice(0, 3)]);
    assert.deepEqual(numOnly.slice(1).map((o) => o.reply), [ANSWERS.humanAskName(0), ANSWERS.humanAskName(1), ANSWERS.humanAskLater("name", 0)]);
    for (const o of nameOnly) assert.doesNotMatch(o.reply, CLAIM);
    for (const o of numOnly) if (CLAIM.test(o.reply)) assert.equal(o.state.lead.phone, "+919845012345", "a claim only with the number typed in this chat");
  });
  it("C9: interest asks stay capped at 2; a human request after the cap still asks", async () => {
    const out = await run(["What is the price of Blue Diamond?", "No thanks", "Which strains do you have?", "No", "How long does delivery take?", "Can I visit your shop?", "Can I talk to the owner?"]);
    const asked = out.map((o) => ASK_RE.test(o.reply));
    assert.deepEqual(asked, [true, false, true, false, false, false, true]);
  });
  it("10 consecutive requests before details and 10 after: no repeated reply in either run (or across)", async () => {
    const msgs = Array.from({ length: 10 }, (_, i) => SIX[i % SIX.length]!);
    const out = await run([...msgs, "I'm Meena, 9123456780", ...msgs]);
    const before = out.slice(0, 10).map((o) => o.reply);
    const after = out.slice(11).map((o) => o.reply);
    assert.equal(new Set(before).size, 10);
    assert.equal(new Set(after).size, 10);
    assert.equal(new Set(out.map((o) => o.reply)).size, 21);
    for (const r of before) assert.match(r, ASK_RE);
    for (const r of after) assert.match(r, /passed|are with Shiva|already has your details|shared your details/);
  });
  it("the composed pickers never repeat for 2000 requests (asks, passed, privacy, declines)", () => {
    const families: Array<(k: number) => string> = [
      (k) => ANSWERS.humanAskLater("both", k), (k) => ANSWERS.humanAskLater("phone", k, "Arjun"), (k) => ANSWERS.humanAskLater("name", k),
      (k) => ANSWERS.humanPassed("Priya", k), (k) => ANSWERS.privacyNoDetails(k), (k) => ANSWERS.privacyHasDetails(k), (k) => ANSWERS.askDeclined(k),
    ];
    for (const f of families) {
      const all = Array.from({ length: 2000 }, (_, k) => f(k));
      assert.equal(new Set(all).size, all.length);
      for (const x of all.slice(0, 200)) {
        assert.equal(guardReply(x).text, x);
        assert.doesNotMatch(x, /reserve|stock|photo|video|book|!/i);
      }
    }
    assert.equal(composeRot(0, [["a"], ["b"]]), "a b");
  });
});
