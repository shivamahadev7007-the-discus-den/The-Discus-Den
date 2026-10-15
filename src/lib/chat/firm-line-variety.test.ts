/**
 * Kiara/Lea, 15 Oct 2026: three off-list asks in one chat got the firm line word for word.
 * Shiva's rule: no reply repeats word for word. The firm line rotates; meaning is unchanged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ANSWERS } from "./answers.ts";
import type { CatalogLoader } from "./catalog.ts";
import { respond, type ChatState } from "./engine.ts";
import { guardReply } from "./guard.ts";

const catalog: CatalogLoader = {
  strains: async () => [
    { name: "Blue Diamond Babies", size: "1.5 inch", priceText: "₹450", priceValue: 450, available: true, description: "Young." },
  ] as never,
  foods: async () => ({ frozen: [], pellets: [] }) as never,
};

describe("LB-5 firm line never repeats in a chat", () => {
  it("Kiara's three asks get three different firm lines", async () => {
    let state: ChatState | null = null;
    const replies: string[] = [];
    for (const m of ["Do you have smaller blue diamond babies?", "Do you have any fry?", "Do you have coin size discus?", "any juvenile discus?", "anything cheaper?"]) {
      const r = await respond(state, m, { catalog });
      state = r.state;
      assert.equal(r.intent, "unlisted_firm", m);
      replies.push(r.reply);
    }
    assert.equal(replies[0], ANSWERS.unlistedFirm, "first one is the original line");
    assert.equal(new Set(replies).size, replies.length, "no two firm replies identical");
  });
  it("every variant keeps the meaning and the rules", () => {
    for (let k = 0; k < 8; k++) {
      const line = ANSWERS.unlistedFirmRot(k);
      assert.match(line, /thediscusden\.com\/available/);
      assert.match(line, /sizes, ages or prices/);
      assert.doesNotMatch(line, /₹|\brs\b|\d+\s*%|discount|per piece|\bsale\b/i);
      assert.doesNotMatch(line, /shall i|want me to|pass your|i'?ll check|let me check|ask shiva/i);
      assert.equal(guardReply(line).text, line, `guard must not rewrite variant ${k}`);
    }
  });
});
