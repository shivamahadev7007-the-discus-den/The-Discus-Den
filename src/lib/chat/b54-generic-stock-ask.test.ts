/**
 * B-54 (Medium): "do you have discus?" and "any fish?" got "didn't catch that". A short generic
 * stock ask now gets the live list, while loss, food and discount asks keep their own replies.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CatalogLoader } from "./catalog.ts";
import { respond } from "./engine.ts";

const cards = [
  { name: "Red Panda Eagles", size: "4 inch", priceText: "₹4,500", priceValue: 4500, available: true, description: "" },
  { name: "Yellow Panda Eagles", size: "4 inch", priceText: "₹3,500", priceValue: 3500, available: true, description: "" },
] as never;
const catalog: CatalogLoader = { strains: async () => cards, foods: async () => ({ frozen: [], pellets: [] }) as never };

describe("B-54: generic stock asks get the list", () => {
  for (const ask of ["do you have discus?", "any fish?", "Do you have any discus?", "you have fish?", "any discus available", "got any fish"]) {
    it(ask, async () => {
      const r = await respond(null, ask, { catalog });
      assert.notEqual(r.intent, "unclear");
      assert.match(r.reply, /Red Panda Eagles/);
      assert.match(r.reply, /Yellow Panda Eagles/);
    });
  }
  it("loss, food and discount asks keep their own replies", async () => {
    assert.notEqual((await respond(null, "any fish died?", { catalog })).intent, "available");
    assert.match((await respond(null, "any discount?", { catalog })).intent, /discount/);
    assert.doesNotMatch((await respond(null, "do you have fish food?", { catalog })).reply, /Panda Eagles/);
  });
});
