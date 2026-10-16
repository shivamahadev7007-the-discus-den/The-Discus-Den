/**
 * Shiva, 16 Oct 2026: "Do you have Yellow Panda discus?" got "That one isn't on our available page",
 * though Yellow Panda Eagles is listed. "panda" sits on two cards and is only 5 letters, so the
 * matcher ignored it. A shared name word, or a fitting colour plus a name word, must now match.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CatalogLoader } from "./catalog.ts";
import { matchStrains, respond } from "./engine.ts";

const cards = [
  { name: "Red Panda Eagles", size: "4 inch", priceText: "₹4,500", priceValue: 4500, available: true, description: "" },
  { name: "Yellow Panda Eagles", size: "4 inch", priceText: "₹3,500", priceValue: 3500, available: true, description: "" },
  { name: "Red Ninja Discus", size: "4 inch", priceText: "₹3,500", priceValue: 3500, available: true, description: "" },
] as never;
const catalog: CatalogLoader = { strains: async () => cards, foods: async () => ({ frozen: [], pellets: [] }) as never };
const names = (q: string) => matchStrains(q, cards).cards.map((c) => c.name);

describe("Yellow Panda is found", () => {
  it("colour + panda picks one card", () => {
    assert.deepEqual(names("Do you have Yellow Panda discus?"), ["Yellow Panda Eagles"]);
    assert.deepEqual(names("red panda price"), ["Red Panda Eagles"]);
  });
  it("bare panda lists both panda cards", () => {
    assert.deepEqual(names("panda discus").sort(), ["Red Panda Eagles", "Yellow Panda Eagles"]);
  });
  it("a colour no panda card has still matches nothing", () => {
    assert.deepEqual(names("do you have green panda"), []);
  });
  it("the chat reply shows Yellow Panda Eagles with its price, not 'isn't on our available page'", async () => {
    const r = await respond(null, "Do you have Yellow Panda discus?", { catalog });
    assert.match(r.reply, /Yellow Panda Eagles/);
    assert.match(r.reply, /3,500/);
    assert.doesNotMatch(r.reply, /isn't on our available page/i);
  });
});
