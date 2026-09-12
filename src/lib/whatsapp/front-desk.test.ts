import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  handleFrontDeskMessage,
  resetSessions,
  getSession,
  runScript,
} from "./front-desk.ts";

beforeEach(() => {
  resetSessions();
});

describe("FE-2 front-desk greeting & intent", () => {
  it("TC-greeting: hi → warm Den greeting, CONTINUE", () => {
    const r = handleFrontDeskMessage("wa1", "Hi");
    assert.equal(r.outcome, "CONTINUE");
    assert.match(r.text, /The Discus Den/);
    assert.equal(getSession("wa1").step, "intent");
  });

  it("TC-02-ish: hi loops after nudges → HARD_FAIL", () => {
    handleFrontDeskMessage("wa2", "Hi");
    handleFrontDeskMessage("wa2", "hello");
    const r = handleFrontDeskMessage("wa2", "hi");
    assert.equal(r.outcome, "HARD_FAIL");
  });
});

describe("FE-2 price gate", () => {
  it("TC-03: price list only → SOFT_FAIL soft gate, asks state", () => {
    const r = handleFrontDeskMessage("wa3", "Price list? Cheapest discus?");
    assert.equal(r.outcome, "SOFT_FAIL");
    assert.match(r.text, /state/i);
    assert.doesNotMatch(r.text, /₹\d|rs\.?\s*\d/i);
  });

  it("qualified then exact price → ESCALATE (no bot price)", () => {
    const replies = runScript("wa21b", [
      "want discus",
      "Tamil Nadu",
      "yes kept discus before",
      "yes tank cycled heater filtration ready",
      "yes I accept",
    ]);
    const last = handleFrontDeskMessage("wa21b", "exact price for 5 fish now");
    assert.ok(
      last.outcome === "ESCALATE" || last.outcome === "PASS",
      `expected ESCALATE or PASS, got ${last.outcome}`,
    );
    assert.doesNotMatch(last.text, /₹\s*\d{2,}/);
    assert.ok(replies.length >= 4);
  });
});

describe("FE-2 location gate", () => {
  it("TC-06: Mumbai → HARD_FAIL outside ship", () => {
    handleFrontDeskMessage("wa6", "Hi");
    const r = handleFrontDeskMessage("wa6", "I'm in Mumbai, want discus");
    assert.equal(r.outcome, "HARD_FAIL");
    assert.match(r.text, /Tamil Nadu|Kerala|Karnataka/);
  });

  it("TC-07: Kerala / Kochi → continue", () => {
    handleFrontDeskMessage("wa7", "want discus");
    const r = handleFrontDeskMessage("wa7", "Kochi");
    assert.equal(r.outcome, "CONTINUE");
    assert.equal(getSession("wa7").shipState, "KL");
    assert.match(r.text, /kept discus|experience|cichlid/i);
  });

  it("TC-08: Bangalore → KA", () => {
    handleFrontDeskMessage("wa8", "stock please");
    const r = handleFrontDeskMessage("wa8", "Bangalore");
    assert.equal(getSession("wa8").shipState, "KA");
    assert.equal(r.outcome, "CONTINUE");
  });

  it("TC-09: Hyderabad → TS", () => {
    handleFrontDeskMessage("wa9", "availability");
    handleFrontDeskMessage("wa9", "Hyderabad");
    assert.equal(getSession("wa9").shipState, "TS");
  });

  it("TC-10: Vizag → AP", () => {
    handleFrontDeskMessage("wa10", "fish");
    handleFrontDeskMessage("wa10", "Vizag");
    assert.equal(getSession("wa10").shipState, "AP");
  });

  it("TC-20: Dubai → HARD_FAIL", () => {
    handleFrontDeskMessage("wa20", "hi");
    const r = handleFrontDeskMessage("wa20", "Ship to Dubai?");
    assert.equal(r.outcome, "HARD_FAIL");
  });

  it("TC-11: vague South India → clarify then ESCALATE", () => {
    handleFrontDeskMessage("wa11", "want discus");
    const r1 = handleFrontDeskMessage("wa11", "Somewhere in South India");
    assert.equal(r1.outcome, "CONTINUE");
    assert.match(r1.text, /exact state|state/i);
    const r2 = handleFrontDeskMessage("wa11", "somewhere south");
    assert.equal(r2.outcome, "ESCALATE");
  });
});

describe("FE-2 off-topic & hard refusals", () => {
  it("TC-32: relationship advice → SOFT_FAIL", () => {
    const r = handleFrontDeskMessage("wa32", "Need relationship advice");
    assert.equal(r.outcome, "SOFT_FAIL");
    assert.match(r.text, /discus enquir/i);
  });

  it("TC-33: off-topic persist → HARD_FAIL", () => {
    handleFrontDeskMessage("wa33", "Need relationship advice");
    const r = handleFrontDeskMessage("wa33", "what about politics today");
    assert.equal(r.outcome, "HARD_FAIL");
  });

  it("TC-17: stock count / mortality → refuse stats", () => {
    handleFrontDeskMessage("wa17", "hi");
    const r = handleFrontDeskMessage(
      "wa17",
      "Do you show mortality % / stock count?",
    );
    assert.match(r.text, /don.?t share stock counts|mortality/i);
    assert.doesNotMatch(r.text, /\d+%/);
  });
});

describe("FE-2 experience / tank / seriousness", () => {
  it("TC-12: beginner one cheap fish → SOFT_FAIL", () => {
    runScript("wa12", ["want discus", "TN"]);
    const r = handleFrontDeskMessage(
      "wa12",
      "First aquarium, want 1 small fish cheap",
    );
    assert.equal(r.outcome, "SOFT_FAIL");
  });

  it("TC-13: tank not ready → SOFT_FAIL", () => {
    runScript("wa13", [
      "want discus",
      "Kerala",
      "yes kept discus before",
    ]);
    const r = handleFrontDeskMessage("wa13", "Tank not bought yet, no heater");
    assert.equal(r.outcome, "SOFT_FAIL");
  });

  it("TC-14: club / reseller → ESCALATE", () => {
    const r = handleFrontDeskMessage(
      "wa14",
      "Club order / 50 fish / reseller rates",
    );
    assert.equal(r.outcome, "ESCALATE");
  });
});

describe("FE-2 multi-answer & happy path", () => {
  it("TC-37: Chennai + kept discus in one msg → skip re-ask, ask tank", () => {
    handleFrontDeskMessage("wa37", "want Yellow Diamond");
    const r = handleFrontDeskMessage(
      "wa37",
      "I am staying in Chennai currently and have kept discus for 2 years",
    );
    assert.equal(getSession("wa37").shipState, "TN");
    assert.equal(getSession("wa37").experienceOk, true);
    assert.match(r.text, /tank|cycled|group|heater/i);
    assert.doesNotMatch(r.text, /which state/i);
  });

  it("TC-05-ish full tree → PASS → handoff", () => {
    const replies = runScript("wa5", [
      "Hi",
      "I'm in Chennai, TN — kept discus 2 yrs, want 6 fish",
      "Yes 4ft cycled heater filtration ready for group",
      "Yes comfortable choosing from the stock share",
      "Yellow Diamonds pair as shown",
    ]);
    const last = replies[replies.length - 1]!;
    assert.equal(last.outcome, "PASS");
    assert.match(last.text, /Shiva/);
    assert.doesNotMatch(last.text, /₹\s*\d/);
  });
});

describe("FE-2 cherry-pick stock-offer", () => {
  function toStock(id: string) {
    runScript(id, [
      "want discus",
      "TN",
      "yes kept discus 2 years",
      "yes cycled ready heater filtration",
      "yes I will choose from stock share",
    ]);
  }

  it("TC-27: same strain but smaller → SOFT_FAIL", () => {
    toStock("wa27");
    const r = handleFrontDeskMessage(
      "wa27",
      "Same strain but 0.5 inch smaller than the video",
    );
    assert.equal(r.outcome, "SOFT_FAIL");
  });

  it("TC-29: cherry-pick persist → HARD_FAIL", () => {
    toStock("wa29");
    handleFrontDeskMessage(
      "wa29",
      "Different striation / prettier one from the same batch",
    );
    const r = handleFrontDeskMessage(
      "wa29",
      "same strain but 0.5 inch smaller please",
    );
    assert.equal(r.outcome, "HARD_FAIL");
  });
});

describe("FE-2 FAQ stubs", () => {
  it("TC-22: temperature FAQ then resume", () => {
    handleFrontDeskMessage("wa22", "Hi");
    const r = handleFrontDeskMessage(
      "wa22",
      "What temperature do discus need?",
    );
    assert.match(r.text, /28–30|28-30/);
    assert.equal(r.outcome, "CONTINUE");
  });

  it("sessions are isolated by waId", () => {
    handleFrontDeskMessage("a", "Hi");
    handleFrontDeskMessage("b", "Price list?");
    assert.equal(getSession("a").step, "intent");
    assert.equal(getSession("b").step, "location");
  });
});
