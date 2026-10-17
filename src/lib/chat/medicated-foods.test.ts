/**
 * Shiva, 17 Oct 2026: the Medicated shelf (GHM / BHM / Bloodworm - Dewormer, 100 g) and BHM with
 * Growth Enhancer must be offered by name. "medicated" means dewormer; a growth ask never gets a
 * dewormer pack and a dewormer ask never gets the plain or growth mix.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CatalogLoader } from "./catalog.ts";
import { respond } from "./engine.ts";

const p = (size: string, price: number) => ({ size, price, priceText: `₹${price.toLocaleString("en-IN")}` });
const frozen = [
  { name: "Goat Heart Mix", description: "", packs: [p("250 g", 500), p("500 g", 899), p("1 kg", 1599)] },
  { name: "Buffalo Heart Mix", description: "", packs: [p("250 g", 350), p("500 g", 650), p("1 kg", 1200)] },
  { name: "Bloodworms", description: "", packs: [p("250 g", 450)] },
  { name: "BHM with Growth Enhancer", description: "", packs: [p("250 g", 625), p("500 g", 1100), p("1 kg", 2000)] },
  { name: "GHM - Dewormer", description: "", packs: [p("100 g", 250)] },
  { name: "BHM - Dewormer", description: "", packs: [p("100 g", 190)] },
  { name: "Bloodworm - Dewormer", description: "", packs: [p("100 g", 230)] },
];
const catalog: CatalogLoader = { strains: async () => [], foods: async () => ({ frozen, pellets: [] }) as never } as never;
const ask = async (m: string) => (await respond(null, m, { catalog })).reply;

describe("Medicated (dewormer) and growth foods", () => {
  it("medicated GHM gets GHM - Dewormer only", async () => {
    for (const m of ["do you have medicated GHM?", "ghm dewormer price"]) {
      const r = await ask(m);
      assert.match(r, /GHM - Dewormer: 100 g ₹250/, m);
      assert.doesNotMatch(r, /Goat Heart Mix|BHM - Dewormer/, m);
    }
  });
  it("a bare dewormer ask lists all three dewormer packs and no plain mix", async () => {
    const r = await ask("do you have dewormer food?");
    assert.match(r, /GHM - Dewormer/);
    assert.match(r, /BHM - Dewormer/);
    assert.match(r, /Bloodworm - Dewormer/);
    assert.doesNotMatch(r, /Goat Heart Mix|Growth/);
  });
  it("medicated bhm and bloodworm dewormer pick their own pack", async () => {
    assert.match(await ask("medicated bhm"), /^BHM - Dewormer: 100 g ₹190/);
    assert.match(await ask("bloodworm dewormer"), /^Bloodworm - Dewormer: 100 g ₹230/);
  });
  it("BHM+ / growth asks get BHM with Growth Enhancer, never a dewormer pack", async () => {
    for (const m of ["BHM+ price", "bhm with growth 250g", "growth enhancer"]) {
      const r = await ask(m);
      assert.match(r, /BHM with Growth Enhancer: 250 g ₹625/, m);
      assert.doesNotMatch(r, /Dewormer/, m);
    }
  });
  it("plain GHM still gets Goat Heart Mix", async () => {
    const r = await ask("ghm price");
    assert.match(r, /Goat Heart Mix: 250 g ₹500/);
    assert.doesNotMatch(r, /Dewormer/);
  });
});
