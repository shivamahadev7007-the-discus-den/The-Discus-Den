/**
 * Kiara, 15 Oct 2026 (Medium): "Hi, what is the price of Blue Diamond babies?" got the off-list firm line,
 * because "babies" is an off-list size word. It is part of a listed product's name, so it must get the price.
 * Real off-list asks (smaller, coin size, a size word with no listed product) still get the firm line.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ANSWERS } from "./answers.ts";
import type { CatalogLoader } from "./catalog.ts";
import { respond } from "./engine.ts";

const catalog: CatalogLoader = {
  strains: async () => [
    { name: "Blue Diamond Babies", size: "1.5 inch", priceText: "₹450", priceValue: 450, available: true, description: "Young blue diamonds." },
    { name: "Blue Diamonds (Big)", size: "4 inch", priceText: "₹3,000", priceValue: 3000, available: true, description: "Electric blue." },
    { name: "Blue Diamonds (Small)", size: "2.5 inch", priceText: "₹1,200", priceValue: 1200, available: true, description: "Electric blue." },
  ] as never,
  foods: async () => ({ frozen: [], pellets: [] }) as never,
};
const ask = async (m: string) => respond(null, m, { catalog });

describe("Listed product name containing a size word", () => {
  for (const m of [
    "Hi, what is the price of Blue Diamond babies?",
    "what is the price of blue diamond babies",
    "Blue Diamond Babies price?",
    "Do you have blue diamond babies?",
    "how much for blue diamond baby",
  ]) {
    it(`"${m}" gets the listed product, not the firm line`, async () => {
      const r = await ask(m);
      assert.notEqual(r.intent, "unlisted_firm", r.reply);
      assert.notEqual(r.reply, ANSWERS.unlistedFirm);
      assert.match(r.reply, /Blue Diamond Babies/);
      assert.match(r.reply, /450/);
    });
  }
});

describe("Real off-list asks still get the firm line", () => {
  for (const m of [
    "do you have smaller blue diamond babies?",
    "any coin size blue diamonds?",
    "can I get juvenile panda discus?",
    "any fry available?",
  ]) {
    it(`"${m}" is firm`, async () => {
      const r = await ask(m);
      assert.equal(r.intent, "unlisted_firm", r.reply);
    });
  }
});

// B-53 (Shiva, 16 Oct): one matching word means share the match. "baby" matches the listed
// Blue Diamond Babies even though the colour differs, so it's shown instead of the firm line.
describe("A size word that is a listed name shares the match", () => {
  it('"do you have baby red discus?" shows Blue Diamond Babies', async () => {
    const r = await ask("do you have baby red discus?");
    assert.notEqual(r.intent, "unlisted_firm", r.reply);
    assert.match(r.reply, /Blue Diamond Babies/);
  });
});
