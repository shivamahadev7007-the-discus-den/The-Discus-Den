/**
 * Live sign-off (Kiara, 15 Oct 2026, Low): "Thanks, that's all." got "Sorry, I didn't catch that".
 * A sign-off ("that's all", "nothing else", "I'm good", optionally with thanks / no) is a warm goodbye.
 * A sign-off with a real question in it is not a goodbye.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ANSWERS } from "./answers.ts";
import type { CatalogLoader } from "./catalog.ts";
import { isCourtesyOnly, pleasantryOnly, respond, type ChatState } from "./engine.ts";
import { guardReply } from "./guard.ts";

const catalog: CatalogLoader = {
  strains: async () => [
    { name: "Blue Diamonds (Big)", size: "4 inch", price: "₹3,000", priceValue: 3000, available: true, description: "Electric blue." },
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
function assertBye(r: { reply: string; intent: string }, ctx: string): void {
  assert.notEqual(r.intent, "unclear", `${ctx}: fallback`);
  assert.doesNotMatch(r.reply, /didn't catch that/, `${ctx}: fallback text`);
  assert.equal(r.intent, "bye", `${ctx}: intent`);
  assert.equal(r.reply, ANSWERS.bye, `${ctx}: reply`);
  assert.equal(guardReply(r.reply).text, r.reply, `${ctx}: guard must not rewrite`);
}

describe("Live sign-off · Kiara's repro", () => {
  it("the live chat ends with a goodbye, not the fallback", async () => {
    const out = await run([
      "Hi, do you have Blue Diamond discus available?",
      "What is the price per piece?",
      "Can I talk to the owner?",
      "My name is Kiara Test and my WhatsApp is +91 90000 00001",
      "Thanks, that's all.",
    ]);
    assertBye(out[4]!, "repro");
  });
  it("same with a curly apostrophe", async () => {
    const out = await run(["What is the price per piece?", "Thanks, that\u2019s all."]);
    assertBye(out[1]!, "curly");
  });
});

describe("Live sign-off · variants", () => {
  const SIGNOFFS = [
    "Thanks, that's all.", "thank you, that's all for now", "thats all", "That's it, thanks!", "That is all.",
    "No, that's all", "Nope, nothing else", "nothing else, thank you", "Nothing more.",
    "I'm good, thanks", "im good", "All good, thanks!", "no more questions, thank you", "that'll be all",
    "Thanks, that's all I needed", "got it, thanks", "ok thanks, that's all. bye",
  ];
  for (const s of SIGNOFFS) {
    it(`"${s}" is a goodbye`, async () => {
      const out = await run(["What is the price per piece?", s]);
      assertBye(out[1]!, s);
      assert.equal(pleasantryOnly(s.toLowerCase().replace(/\u2019/g, "'")), "bye");
      assert.ok(isCourtesyOnly(s), `${s}: courtesy only`);
    });
  }
  it('"no thanks, that\'s all" keeps the existing "no thanks" handling (LB-25 decline / ack), never the fallback', async () => {
    for (const msgs of [["What is the price per piece?", "no thanks, that's all"], ["no thanks, that's all"]]) {
      const out = await run(msgs);
      const r = out[out.length - 1]!;
      assert.notEqual(r.intent, "unclear", msgs.join(" | "));
      assert.doesNotMatch(r.reply, /didn't catch that/);
    }
  });
  it("a sign-off as the very first message is still a goodbye", async () => {
    const [r] = await run(["Thanks, that's all."]);
    assertBye(r!, "first");
  });
});

describe("Live sign-off · real questions are not goodbyes", () => {
  const QUESTIONS = [
    "thanks, that's all? what about the price of blue diamond",
    "is that all the fish you have?",
    "nothing else is available?",
    "I'm good at keeping discus, what do you have?",
    "that's it for blue diamonds, what about shipping to Bangalore?",
  ];
  for (const q of QUESTIONS) {
    it(`"${q}" is not a goodbye`, async () => {
      assert.notEqual(pleasantryOnly(q.toLowerCase()), "bye");
      const out = await run(["What is the price per piece?", q]);
      assert.notEqual(out[1]!.intent, "bye", q);
    });
  }
});
