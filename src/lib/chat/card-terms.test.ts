/**
 * Lea, 16 Oct 2026 (B-53 follow-up): baby cards say "Minimum 5. Store pick-up only. No shipping. No discounts."
 * The bot must repeat that line and must not add "Shipping is extra" or the volume-discount line for them.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAvailableHtml, type CatalogLoader } from "./catalog.ts";
import { respond } from "./engine.ts";

const html = `<article><p class="absolute">1.5 inch</p><h3>Blue Diamond Babies</h3><p>Electric blue. Still small.</p><p class="mt-2">Minimum 5. <!-- -->Store pick-up only. No shipping. <!-- -->No discounts.</p><p>₹450</p></article>
<article><p class="absolute">4 inch</p><h3>Blue Diamonds (Big)</h3><p>Electric blue.</p><p>₹3,000</p></article>`;
const cards = parseAvailableHtml(html);
const catalog: CatalogLoader = { strains: async () => cards, foods: async () => ({ frozen: [], pellets: [] }) } as never;

describe("Card conditions line", () => {
  it("is read from the card exactly", () => {
    const b = cards.find((c) => c.name === "Blue Diamond Babies")!;
    assert.equal(b.terms, "Minimum 5. Store pick-up only. No shipping. No discounts.");
    assert.equal(b.noShipping, true);
    assert.equal(b.noDiscount, true);
    assert.equal(cards.find((c) => c.name === "Blue Diamonds (Big)")!.terms, undefined);
  });
  it("babies alone: conditions shown, no shipping or discount line", async () => {
    const r = await respond(null, "Blue Diamond babies price?", { catalog });
    assert.match(r.reply, /Minimum 5\. Store pick-up only\. No shipping\. No discounts\./);
    assert.doesNotMatch(r.reply, /Shipping is extra/);
    assert.doesNotMatch(r.reply, /5% off/);
  });
  it("mixed list: notes that pick-up cards don't ship or get discounts", async () => {
    const r = await respond(null, "diamond", { catalog });
    assert.match(r.reply, /Cards marked store pick-up only don't ship/);
    assert.match(r.reply, /Cards marked no discounts are excluded/);
  });
});
