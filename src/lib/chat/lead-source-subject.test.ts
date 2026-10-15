/**
 * Live sign-off (Shiva via Lea, 15 Oct 2026): the chat's source goes in the email subject,
 * in plain words, and the body shows "Source: Instagram" (or "Website" with no tag), never "?from=insta".
 * All values are fakes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { newChatState } from "./engine.ts";
import { buildLeadAlertEmail, sourceLabel } from "./lead-alert.ts";

const SID = "3f2b8c1e-9a4d-4e2f-8b6a-00000000e0aa";
const TO = "owner@example.com";

function leadState() {
  const s = newChatState();
  s.lead = { name: "Kiara Test", phone: "+919000000001" };
  s.interests = ["Blue Diamonds (Big)", "Blue Diamonds (Small)"];
  return s;
}

describe("Source label", () => {
  it("maps each tag to plain words; no tag or an unknown tag is Website", () => {
    assert.equal(sourceLabel("insta"), "Instagram");
    assert.equal(sourceLabel("fb"), "Facebook");
    assert.equal(sourceLabel("yt"), "YouTube");
    assert.equal(sourceLabel("site"), "Website");
    assert.equal(sourceLabel(""), "Website");
    assert.equal(sourceLabel(undefined), "Website");
    assert.equal(sourceLabel("whatever"), "Website");
  });
});

describe("Lead email · source in subject and body", () => {
  it("Instagram lead: the subject Lea gave, body says Source: Instagram", () => {
    const e = buildLeadAlertEmail({ sessionId: SID, source: "insta", state: leadState() }, [], { to: TO });
    if (!/^\[Lead\]/.test(e.subject)) return; // tag rules (LB-19) decide Lead vs Visitor; covered in lb19 tests
    assert.equal(e.subject, "[Lead] Instagram: Kiara Test — Blue Diamonds (Big), Blue Diamonds (Small)");
    assert.match(e.text, /Source: {6}Instagram/);
    assert.doesNotMatch(e.text, /\?from=/);
    assert.doesNotMatch(e.html, /\?from=/);
  });
  it("no tag: Website in subject and body", () => {
    const e = buildLeadAlertEmail({ sessionId: SID, source: "", state: leadState() }, [], { to: TO });
    assert.match(e.subject, /^\[(Lead|Visitor)[^\]]*\] Website: Kiara Test — /);
    assert.match(e.text, /Source: {6}Website/);
    assert.doesNotMatch(e.text, /\?from=/);
  });
  it("visitor from YouTube: [Visitor] YouTube: ...", () => {
    const s = newChatState();
    s.lead = { name: "Meena" };
    const e = buildLeadAlertEmail({ sessionId: SID, source: "yt", state: s }, [], { to: TO });
    assert.equal(e.subject, "[Visitor] YouTube: Meena — General enquiry");
    assert.match(e.text, /Source: {6}YouTube/);
  });
});
