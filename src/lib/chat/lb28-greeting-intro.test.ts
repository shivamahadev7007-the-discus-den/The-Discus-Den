/**
 * LB-28 (High, Shiva via Lea 8 Oct 6:10 PM): a greeting + intro (+ "I love discus") + buy
 * intent in ONE message must never get "Sorry, I didn't catch that".
 * Live repro: "Hi - I am Shruti. I love Discus keeping and am planning to buy Discus."
 *  - the greeting is returned warmly, by name (LB-13), e.g. "Hi Shruti, lovely to meet a fellow Discus keeper!"
 *  - "planning / looking / thinking of / keen to buy ..." is buy intent (LB-22): the existing
 *    buy next step (the window) + the first ask, name-aware (number only) since the name was typed
 *  - name / city only from this chat (LB-24); no word-for-word repeats; never-share intact.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ANSWERS } from "./answers.ts";
import type { CatalogLoader } from "./catalog.ts";
import { introName, newChatFrom, respond, type ChatState } from "./engine.ts";
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
const CLAIM = /\b(I've|I have)\s+(already\s+)?(passed|shared|sent)\b|\bpassed your (details|number)\b|\bShiva (has|already has) your (details|number)\b|are with Shiva/i;
const WINDOW = "Here's what's in the window now:";
function assertGood(r: { reply: string; intent: string; state: ChatState }, ctx: string): void {
  assert.notEqual(r.intent, "unclear", `${ctx}: fallback`);
  assert.doesNotMatch(r.reply, /didn't catch that/, `${ctx}: fallback text`);
  assert.doesNotMatch(r.reply, CLAIM, `${ctx}: no 'passed' claim without a number`);
  assert.equal(guardReply(r.reply).text, r.reply, `${ctx}: guard must not rewrite`);
  assert.doesNotMatch(r.reply, /\d(?:[\s-]*\d){6,}/, "never a full number");
  assert.doesNotMatch(r.reply, /we don'?t deliver|\b(mortality|supplier|breeder)\b|gpay\s*(number|no)|upi\s*id|first[\s-]time\s+code|\b\d+\s+(left|in\s+stock|pieces?\s+available)\b/i);
  assert.doesNotMatch(r.reply, /(^|[^e] )Discus Den/);
  assert.doesNotMatch(r.reply, /reserve|stock alert|photo|video|book/i);
}

describe("LB-28 · the live repro", () => {
  const REPRO = "Hi - I am Shruti. I love Discus keeping and am planning to buy Discus.";
  it("warm greeting by name + the window (buy next step) + the name-aware number ask; name Shruti; ask 1 counted", async () => {
    const [r] = await run([REPRO]);
    assertGood(r!, "repro");
    assert.ok(r!.reply.startsWith(`${ANSWERS.greetIntro("Hi", "Shruti", true, 0)}\n\n${WINDOW}`), r!.reply);
    assert.ok(r!.reply.startsWith("Hi Shruti, lovely to meet a fellow Discus keeper!"));
    assert.ok(r!.reply.endsWith(`\n\n${ANSWERS.humanAskPhone("Shruti", 0)}`), r!.reply);
    assert.equal(r!.intent, "available_list");
    assert.equal(r!.state.lead.name, "Shruti");
    assert.equal(r!.state.lead.phone, undefined);
    assert.equal(r!.state.contactAsk?.count, 1);
    assert.equal(r!.state.contactAsk?.pending, true);
  });
  it("then the number -> saved + closing line by name (a true 'passed' only now)", async () => {
    const out = await run([REPRO, "9845012312"]);
    assert.equal(out[1]!.reply, ANSWERS.handoffClose("Shruti"));
    assert.equal(out[1]!.state.lead.phone, "+919845012312");
  });
  it("nothing from an earlier chat on the same browser (LB-24): same reply as a fresh chat, no old name", async () => {
    const earlier = newChatFrom((await run(["I am Ravi Kumar from Kochi, 9845012345"])).at(-1)!.state);
    const [r] = await run([REPRO], earlier);
    const [cold] = await run([REPRO]);
    assert.equal(r!.reply, cold!.reply);
    assert.doesNotMatch(r!.reply, /Ravi|Kochi|9845012345|\d{2}x+\d{2}/);
    assert.deepEqual(r!.state.lead, { name: "Shruti" });
  });
});

describe("LB-28 · variants", () => {
  const cases: Array<[string, string, boolean, "window" | "ship"]> = [
    ["Hello, I'm Shruti from Pune, planning to buy discus", "Hello", false, "ship"],
    ["hey this is Shruti, I love discus and want to buy some", "Hey", true, "window"],
    ["Hi! Shruti here. Looking to buy Discus", "Hi", false, "window"],
    ["Good evening, my name is Shruti, I keep discus and am thinking of buying a few", "Good evening", true, "window"],
  ];
  for (const [msg, greet, keeper, kind] of cases) {
    it(`'${msg}' -> '${greet} Shruti, ...' + ${kind === "ship" ? "the delivery reply (place named)" : "the window"} + the number ask by name`, async () => {
      const [r] = await run([msg]);
      assertGood(r!, msg);
      const lead = `${ANSWERS.greetIntro(greet, "Shruti", keeper, 0)}\n\n${kind === "ship" ? ANSWERS.shipInStates : WINDOW}`;
      assert.ok(r!.reply.startsWith(lead), r!.reply);
      assert.ok(r!.reply.endsWith(`\n\n${ANSWERS.humanAskPhone("Shruti", 0)}`), r!.reply);
      assert.equal(r!.state.lead.name, "Shruti");
      if (kind === "ship") assert.equal(r!.state.lead.city, "Pune");
      assert.equal(r!.state.contactAsk?.count, 1);
    });
  }
  it("buy-intent phrasings on their own trigger the window + ask 1 (no greeting needed)", async () => {
    for (const m of [
      "I am planning to buy discus", "plan to buy discus soon", "I want to buy some", "looking to buy discus",
      "thinking of buying discus", "interested in buying discus", "I would like to get some discus", "keen to buy discus",
      "getting some discus this month", "we are planning to purchase discus",
    ]) {
      const [r] = await run([m]);
      assertGood(r!, m);
      assert.equal(r!.intent, "available_list", m);
      assert.ok(r!.reply.endsWith(ANSWERS.contactAskPhotos), `${m}: ask 1`);
      assert.equal(r!.state.lead.name, undefined, `${m}: no name`);
    }
  });
  it("'not planning to buy' is not buy intent", async () => {
    const [r] = await run(["I'm not planning to buy discus now"]);
    assert.notEqual(r!.intent, "available_list");
  });
});

describe("LB-28 · greeting + intro without buy intent", () => {
  it("'Hi I am Shruti' -> warm greeting by name + an open question (LB-13 fish-or-food); then 'fish' is answered", async () => {
    const out = await run(["Hi I am Shruti", "fish"]);
    assertGood(out[0]!, "hi i am");
    assert.equal(out[0]!.reply, `${ANSWERS.greetIntro("Hi", "Shruti", false, 0)} ${ANSWERS.greetIntroWelcome} ${ANSWERS.handoffAskLookingFor}`);
    assert.equal(out[0]!.reply, "Hi Shruti, nice to meet you. Welcome to The Discus Den. Our discus are raised, quarantined and held here until they're ready. Are you looking for Discus fish or Discus frozen foods?");
    assert.equal(out[0]!.state.lead.name, "Shruti");
    assert.equal(out[0]!.state.contactAsk, undefined, "no ask on a greeting");
    assert.notEqual(out[1]!.intent, "unclear");
  });
  it("greeting + intro + love of discus, no buy intent -> warm keeper reply, no fallback, no ask", async () => {
    for (const m of ["Hi, I am Shruti. I love discus.", "Hello! This is Shruti, a discus lover here", "Hey, my name is Shruti and I keep discus"]) {
      const [r] = await run([m]);
      assertGood(r!, m);
      assert.match(r!.reply, /^(Hi|Hello|Hey) Shruti, lovely to meet a fellow Discus keeper! /, m);
      assert.equal(r!.state.contactAsk, undefined);
    }
  });
  it("'Hey - how is it going. I am Arjun ...' returns the 'how are you' too", async () => {
    const [r] = await run(["Hi I am Shruti, how are you?"]);
    assert.ok(r!.reply.startsWith("Hi Shruti, nice to meet you. All good here, thanks for asking."), r!.reply);
  });
  it("greeting again later in the chat never repeats the earlier reply word for word", async () => {
    const out = await run(["Hi I am Shruti", "Hi, I am Shruti", "hello I'm Shruti", "Hi I am Shruti, I love discus", "Hi I am Shruti, I love discus"]);
    const r = out.map((o) => o.reply);
    assert.equal(new Set(r).size, r.length, r.join(" | "));
    assert.ok(r[1]!.endsWith(ANSWERS.greetIntroHelp), "the fish-or-food question is asked once");
  });
  it("plain pleasantries keep the LB-13 replies", async () => {
    assert.equal((await run(["Hi"]))[0]!.reply, `${ANSWERS.welcomeGreeting} ${ANSWERS.handoffAskLookingFor}`);
    assert.equal((await run(["hi there"]))[0]!.reply, `${ANSWERS.welcomeGreeting} ${ANSWERS.handoffAskLookingFor}`);
    assert.equal((await run(["I am Shruti"]))[0]!.reply, "Thanks, Shruti. How can I help?");
  });
});

describe("LB-28 · names are not misparsed", () => {
  it("'I am planning to buy' never makes the name 'Planning'; guards kept", async () => {
    for (const m of [
      "Hi I am planning to buy discus", "Hello, I'm planning to buy discus", "hi I am looking to buy discus", "Hi I am new here, planning to buy discus",
      "Hi, you can reach me later, planning to buy discus", "hmm hi, planning to buy discus", "Hi! Hmm here, planning to buy discus", "hey I am interested in buying discus",
      "Hi I am thinking of buying a few", "Hi I am keen to buy discus", "Hello I'm from Pune, planning to buy discus",
    ]) {
      const [r] = await run([m]);
      assertGood(r!, m);
      assert.equal(r!.state.lead.name, undefined, `${m}: name ${r!.state.lead.name}`);
      assert.doesNotMatch(r!.reply, /\b(Planning|Looking|New|Interested|Thinking|Keen|Hmm),/);
    }
    assert.equal(introName("I am planning to buy discus"), null);
    assert.equal(introName("You can reach me on WhatsApp"), null);
    assert.equal(introName("Hi - I am Shruti. I love Discus keeping"), "Shruti");
  });
});

describe("LB-28 · interest cap", () => {
  it("the repro's ask is ask 1; a later interest turn gets ask 2; then no more interest asks; a human request still asks", async () => {
    const out = await run([
      "Hi - I am Shruti. I love Discus keeping and am planning to buy Discus.",
      "No",
      "What is the price of Blue Diamond?",
      "No",
      "How long does delivery take?",
      "Can I visit your shop?",
      "Can I talk to the owner?",
    ]);
    assert.equal(out[0]!.state.contactAsk?.count, 1);
    assert.ok(out[2]!.reply.endsWith(ANSWERS.humanAskPhone("Shruti", 1)), out[2]!.reply);
    assert.equal(out[2]!.state.contactAsk?.count, 2);
    assert.equal(out[4]!.state.contactAsk?.count, 2);
    assert.equal(out[5]!.state.contactAsk?.count, 2);
    assert.match(out[6]!.reply, /Shruti/);
    assert.match(out[6]!.reply, /WhatsApp number/);
    for (const o of out) assert.doesNotMatch(o.reply, CLAIM);
    assert.equal(new Set(out.map((o) => o.reply)).size, out.length, "no word-for-word repeats");
  });
});

describe("LB-28 · broad sweep: greeting + intro + intent never hits the fallback", () => {
  const greetings = ["Hi", "Hello", "Hey", "Good evening", "Hi -", "Hello!", "Good morning,", "hii"];
  const intros = ["I am Shruti.", "I'm Shruti,", "this is Shruti,", "my name is Shruti.", "Shruti here.", "myself Shruti,"];
  const middles = ["", "I love Discus keeping and", "I keep discus and", "I'm a discus lover and", ""];
  const intents = [
    "am planning to buy Discus.", "want to buy some discus", "looking to buy a pair", "thinking of buying a few", "interested in buying discus",
    "would like to get some discus", "keen to buy discus", "what is the price of blue diamond?", "do you deliver to Chennai?", "how do I order?",
    "can I visit your shop?", "which strains do you have?",
  ];
  const combos: string[] = [];
  for (let i = 0; i < 60; i++) {
    const g = greetings[i % greetings.length]!;
    const n = intros[(i * 5) % intros.length]!;
    const mid = middles[(i * 3) % middles.length]!;
    const it_ = intents[(i * 7) % intents.length]!;
    if (n === "Shruti here." && !/^(hi|hello|hey|good)/i.test(g)) continue;
    combos.push(`${g} ${n} ${mid ? `${mid} ` : ""}${it_}`.replace(/\s+/g, " "));
  }
  it(`${combos.length} combos: never the fallback, greeted by name, a real answer, ask 1 by name when interest`, async () => {
    assert.ok(combos.length >= 50);
    for (const m of combos) {
      const [r] = await run([m]);
      assertGood(r!, m);
      assert.match(r!.reply, /^(Hi|Hello|Hey|Good (morning|evening)) Shruti, /, m);
      assert.equal(r!.state.lead.name, "Shruti", m);
      if (r!.state.contactAsk?.count) assert.ok(r!.reply.endsWith(ANSWERS.humanAskPhone("Shruti", 0)), `${m} -> ${r!.reply}`);
    }
  });
});

describe("LB-28 · wider matrix (greetings x intros x 'love discus' x questions)", () => {
  it("~1,500 combos: never the fallback; a name is only ever the one typed", async () => {
    const G = ["Hi", "Hello there,", "Hey!", "Good afternoon -", "Namaste,", "Vanakkam"];
    const I = ["", "I am Kavya.", "I'm Rohit Sharma,", "this is Priya from Chennai,", "Kavya here.", "my name is Anil,"];
    const M = ["", "I love discus and", "big fan of discus,", "I have been keeping discus for years and"];
    const X = ["planning to buy discus", "I'm planning to buy", "want to get some discus", "how much is a pair?", "do you ship to Hyderabad?", "how to pay?", "I am thinking of buying discus", "can I come see the fish?", "any blue diamonds?", "how are you?", ""];
    let n = 0;
    for (const g of G) for (const i of I) for (const m of M) for (const x of X) {
      if (!i && !m && !x) continue;
      const msg = `${g} ${i} ${m} ${x}`.replace(/\s+/g, " ").trim();
      const [r] = await run([msg]);
      n++;
      assert.notEqual(r!.intent, "unclear", msg);
      assert.doesNotMatch(r!.reply, /didn't catch that/, msg);
      assert.doesNotMatch(r!.reply, CLAIM, msg);
      if (r!.state.lead.name) assert.ok(["Kavya", "Rohit Sharma", "Priya", "Anil"].includes(r!.state.lead.name), `${msg}: name ${r!.state.lead.name}`);
      if (i) assert.ok(r!.state.lead.name, `${msg}: name missed`);
    }
    assert.ok(n > 1500);
  });
});
