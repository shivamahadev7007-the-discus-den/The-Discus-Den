/** B-52 (Low, Shiva 17 Oct 2026): the bot must keep the capitals a customer typed in their name. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { introName, parseName } from "./engine.ts";

describe("B-52: names keep their typed capitals", () => {
  it("Kiara YT stays Kiara YT", () => {
    assert.equal(parseName("Kiara YT"), "Kiara YT");
    assert.equal(parseName("my name is Kiara YT"), "Kiara YT");
    assert.equal(introName("my name is Kiara YT"), "Kiara YT");
  });
  it("mixed case like McDonald is kept", () => assert.equal(parseName("Ravi McDonald"), "Ravi McDonald"));
  it("all-lowercase names still get capitals", () => assert.equal(parseName("ravi kumar"), "Ravi Kumar"));
  it("a name typed fully in capitals is shown in normal case", () => assert.equal(parseName("RAVI KUMAR"), "Ravi Kumar"));
});
