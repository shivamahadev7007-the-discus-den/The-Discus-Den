/**
 * LB-4: lead alerts by email (Resend via plain fetch).
 * No real keys, phone numbers or codes here: all values are fakes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCatalogLoader, type CatalogLoader } from "./catalog.ts";
import { newChatState, type ChatState } from "./engine.ts";
import { handleChatRequest } from "./http.ts";
import {
  buildLeadAlertEmail,
  customerEmailFromTranscript,
  DEFAULT_ALERT_FROM,
  escapeHtml,
  RESEND_ENDPOINT,
  sendLeadAlert,
  type AlertFetch,
  type LeadForAlert,
  type TranscriptLine,
} from "./lead-alert.ts";
import { createMemoryChatStore } from "./store.ts";

const FAKE_KEY = "re_test_FAKEKEY_123";
const TO = "owner@example.com";
const EMAIL_ENV = { CHAT_LEAD_ALERT_MODE: "email", RESEND_API_KEY: FAKE_KEY, CHAT_LEAD_ALERT_EMAIL_TO: TO };
const SID = "3f2b8c1e-9a4d-4e2f-8b6a-00000000e001";
/**
 * LB-6: "Talk to Shiva" no longer starts a handoff (it steers to the site), so
 * tests that exercise the handoff mechanics open one the genuine way: a store
 * visit request, then "yes" to "Shall I pass your details?".
 */
const OPEN = ["Can I visit the store?", "yes"];
const HANDOFF = [...OPEN, "Ravi", "9845012345", "Kochi", "single", "train", "ready now"];

function offlineCatalog(): CatalogLoader {
  return createCatalogLoader({ fetch: async () => ({ ok: false, status: 500, text: async () => "" }) });
}

function post(body: unknown, sid = SID): Request {
  return new Request("https://thediscusden.com/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://thediscusden.com", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify({ sessionId: sid, source: "site", ...(body as object) }),
  });
}

function leadState(over: Partial<ChatState> = {}): ChatState {
  const s = newChatState();
  s.lead = { name: "Ravi <b>Kumar</b>", phone: "+919845012345", city: "Kochi", pairSingle: "pair" };
  s.tags = { buyer: "hobbyist", history: "first-timer", heat: "hot" };
  s.flags = ["DOA CLAIM", "LONG HOLD"];
  s.interests = ["Red Ninja Discus", "Yellow Diamonds"];
  s.completed = true;
  return Object.assign(s, over);
}

const TRANSCRIPT: TranscriptLine[] = [
  { role: "user", text: "Hi, my fish <died> on arrival & I'm upset" },
  { role: "bot", text: "Sorry to hear that. What's your name?" },
  { role: "user", text: "Ravi, email me at ravi.k@example.com" },
  { role: "bot", text: "Thanks Ravi. Your WhatsApp number?" },
  { role: "user", text: "98450 12345" },
];

function recorder(status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: AlertFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: status < 300, status, text: async () => (status < 300 ? '{"id":"x"}' : '{"message":"bad"}') };
  };
  return { calls, fetchImpl };
}

async function runChat(deps: Parameters<typeof handleChatRequest>[1], msgs: string[], sid = SID) {
  const out: Array<{ status: number; reply: string; handoff: boolean }> = [];
  for (const message of msgs) {
    const res = await handleChatRequest(post({ message }, sid), deps);
    out.push({ status: res.status, ...((await res.json()) as { reply: string; handoff: boolean }) });
  }
  return out;
}

describe("LB-4 · lead alert email content", () => {
  const lead: LeadForAlert = { sessionId: SID, source: "insta", state: leadState() };
  const email = buildLeadAlertEmail(lead, TRANSCRIPT, { to: TO, now: new Date("2026-10-02T19:00:00Z") });

  it("subject: New chat lead: <name> — <summary with tags, strains, place>", () => {
    assert.match(email.subject, /^New chat lead: Ravi <b>Kumar<\/b> — DOA CLAIM · LONG HOLD · Red Ninja Discus, Yellow Diamonds · Kochi · pair$/);
    assert.doesNotMatch(email.subject, /[\r\n]/);
  });

  it("from/to: default sender and env recipient", () => {
    assert.equal(email.from, DEFAULT_ALERT_FROM);
    assert.equal(DEFAULT_ALERT_FROM, "The Discus Den Chat <onboarding@resend.dev>");
    assert.deepEqual(email.to, [TO]);
  });

  it("text part: name, phone, customer-typed email, summary, tags, full transcript", () => {
    assert.match(email.text, /Customer: Ravi <b>Kumar<\/b>/);
    assert.match(email.text, /Phone\/WhatsApp: \+919845012345/);
    assert.match(email.text, /Email: ravi\.k@example\.com/);
    assert.match(email.text, /Tags: DOA CLAIM · LONG HOLD/);
    assert.match(email.text, /TDD CHAT LEAD/);
    for (const line of TRANSCRIPT) assert.ok(email.text.includes(line.text), line.text);
    assert.match(email.text, /Visitor: Hi, my fish <died> on arrival & I'm upset/);
  });

  it("html part: everything escaped, transcript present", () => {
    assert.ok(email.html.includes("Ravi &lt;b&gt;Kumar&lt;/b&gt;"));
    assert.ok(email.html.includes("my fish &lt;died&gt; on arrival &amp; I&#39;m upset"));
    assert.ok(!email.html.includes("<died>"));
    assert.ok(!email.html.includes("<b>Kumar"));
    assert.ok(email.html.includes("ravi.k@example.com"));
    assert.ok(email.html.includes("DOA CLAIM · LONG HOLD"));
    assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });

  it("customer email comes only from visitor lines, never bot lines", () => {
    assert.equal(customerEmailFromTranscript([{ role: "bot", text: "write to shop@example.com" }]), null);
    assert.equal(customerEmailFromTranscript(TRANSCRIPT), "ravi.k@example.com");
  });

  it("no contact given -> 'not given', generic summary", () => {
    const s = newChatState();
    s.lead = { name: "Meena" };
    const e = buildLeadAlertEmail({ sessionId: SID, source: "", state: s }, [], { to: TO });
    assert.match(e.subject, /^New chat lead: Meena — General enquiry$/);
    assert.match(e.text, /Phone\/WhatsApp: not given/);
    assert.match(e.text, /Email: not given/);
  });
});

describe("LB-4 · sendLeadAlert modes", () => {
  const lead: LeadForAlert = { sessionId: SID, source: "site", state: leadState() };

  it("mode=email posts once to Resend with bearer key, idempotency key and the built email", async () => {
    const { calls, fetchImpl } = recorder();
    const r = await sendLeadAlert(lead, TRANSCRIPT, { ...EMAIL_ENV, CHAT_LEAD_ALERT_FROM: "TDD <alerts@example.com>" }, fetchImpl);
    assert.deepEqual(r, { sent: true, channel: "email" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, RESEND_ENDPOINT);
    assert.equal(calls[0]!.init.method, "POST");
    const h = calls[0]!.init.headers as Record<string, string>;
    assert.equal(h.Authorization, `Bearer ${FAKE_KEY}`);
    assert.equal(h["Idempotency-Key"], `tdd-chat-lead-${SID}`);
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.equal(body.from, "TDD <alerts@example.com>");
    assert.deepEqual(body.to, [TO]);
    assert.match(body.subject, /^New chat lead: /);
    assert.ok(body.text && body.html);
  });

  it("payload carries no secrets and no phone numbers beyond what the customer typed", async () => {
    const { calls, fetchImpl } = recorder();
    await sendLeadAlert(lead, TRANSCRIPT, EMAIL_ENV, fetchImpl);
    const body = String(calls[0]!.init.body);
    assert.ok(!body.includes(FAKE_KEY), "API key must only be in the header");
    assert.doesNotMatch(body, /RESEND_API_KEY|DATABASE_URL/);
    const digits = (body.match(/(?:\+?91[\s-]?)?[6-9]\d{4}\s?\d{5}/g) ?? []).map((d) => d.replace(/\D/g, "").slice(-10));
    assert.ok(digits.length >= 1);
    for (const d of digits) assert.equal(d, "9845012345", `unexpected number in payload: ${d}`);
  });

  for (const mode of [undefined, "", "off", "OFF"]) {
    it(`mode=${JSON.stringify(mode)} -> no email, log only`, async () => {
      const { calls, fetchImpl } = recorder();
      const r = await sendLeadAlert(lead, TRANSCRIPT, { ...EMAIL_ENV, CHAT_LEAD_ALERT_MODE: mode }, fetchImpl);
      assert.deepEqual(r, { sent: false, channel: "off" });
      assert.equal(calls.length, 0);
    });
  }

  it("mode=email without RESEND_API_KEY -> warning, no fetch, no throw", async () => {
    const { calls, fetchImpl } = recorder();
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => warns.push(String(m));
    try {
      const r = await sendLeadAlert(lead, TRANSCRIPT, { CHAT_LEAD_ALERT_MODE: "email", CHAT_LEAD_ALERT_EMAIL_TO: TO }, fetchImpl);
      assert.equal(r.sent, false);
      assert.equal(r.channel, "email");
    } finally {
      console.warn = orig;
    }
    assert.equal(calls.length, 0);
    assert.ok(warns.some((w) => /lead alert failed.*RESEND_API_KEY is not set/.test(w)), warns.join("|"));
  });

  it("Resend error / network error / timeout -> {sent:false}, logs '[chat] lead alert failed', never throws", async () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => warns.push(String(m));
    try {
      const http500 = await sendLeadAlert(lead, TRANSCRIPT, EMAIL_ENV, recorder(500).fetchImpl);
      assert.deepEqual(http500, { sent: false, channel: "email", error: "http 500" });
      const net = await sendLeadAlert(lead, TRANSCRIPT, EMAIL_ENV, async () => {
        throw new Error("ECONNRESET");
      });
      assert.equal(net.error, "ECONNRESET");
      const t0 = Date.now();
      const hang = await sendLeadAlert(lead, TRANSCRIPT, { ...EMAIL_ENV, CHAT_LEAD_ALERT_TIMEOUT_MS: "50" }, (_u, init) =>
        new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted")))),
      );
      assert.equal(hang.error, "timeout");
      assert.ok(Date.now() - t0 < 2000);
    } finally {
      console.warn = orig;
    }
    assert.equal(warns.filter((w) => w.startsWith("[chat] lead alert failed")).length, 3);
  });
});

describe("LB-4 · /api/chat sends the email once per completed handoff", () => {
  it("full handoff with mode=email -> exactly one Resend call; later turns don't resend", async () => {
    const { calls, fetchImpl } = recorder();
    const store = createMemoryChatStore();
    const deps = {
      store,
      catalog: offlineCatalog(),
      env: EMAIL_ENV,
      sendAlert: (l: LeadForAlert, t: TranscriptLine[]) => sendLeadAlert(l, t, EMAIL_ENV, fetchImpl),
    };
    const out = await runChat(deps, [...HANDOFF, "Talk to Shiva", "thanks", "Talk to Shiva"]);
    assert.ok(out.every((o) => o.status === 200));
    assert.equal(calls.length, 1);
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.match(body.subject, /^New chat lead: Ravi — /);
    assert.match(body.text, /Phone\/WhatsApp: \+919845012345/);
    assert.match(body.text, /Visitor: Can I visit the store\?/);
    assert.match(body.text, /Visitor: ready now/);
    // Customer never gets their stored details echoed back.
    for (const o of out) assert.doesNotMatch(o.reply, /9845012345/);
  });

  it("DOA claim handoff -> subject carries the DOA CLAIM tag", async () => {
    const { calls, fetchImpl } = recorder();
    const deps = {
      store: createMemoryChatStore(),
      catalog: offlineCatalog(),
      sendAlert: (l: LeadForAlert, t: TranscriptLine[]) => sendLeadAlert(l, t, EMAIL_ENV, fetchImpl),
    };
    await runChat(deps, ["My fish arrived dead in the box", "Ravi", "9845012345", "Kochi", "single", "train", "ready now"], "3f2b8c1e-9a4d-4e2f-8b6a-00000000e002");
    assert.equal(calls.length, 1);
    assert.match(JSON.parse(String(calls[0]!.init.body)).subject, /DOA CLAIM/);
  });

  it("mode off (default env) -> no email, reply unchanged", async () => {
    const realFetch = globalThis.fetch;
    let hits = 0;
    globalThis.fetch = (async () => {
      hits += 1;
      throw new Error("should not be called");
    }) as typeof fetch;
    try {
      const out = await runChat({ store: createMemoryChatStore(), catalog: offlineCatalog(), env: {} }, HANDOFF, "3f2b8c1e-9a4d-4e2f-8b6a-00000000e003");
      assert.ok(out.every((o) => o.status === 200));
      assert.equal(hits, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("email failure (real code path, fetch rejects) -> customer still gets the normal 200 reply", async () => {
    const realFetch = globalThis.fetch;
    let hits = 0;
    globalThis.fetch = (async () => {
      hits += 1;
      throw new Error("resend down");
    }) as typeof fetch;
    const orig = console.warn;
    console.warn = () => {};
    try {
      const store = createMemoryChatStore();
      const ok = await runChat({ store, catalog: offlineCatalog(), env: {} }, HANDOFF, "3f2b8c1e-9a4d-4e2f-8b6a-00000000e005");
      const bad = await runChat({ store: createMemoryChatStore(), catalog: offlineCatalog(), env: EMAIL_ENV }, HANDOFF, "3f2b8c1e-9a4d-4e2f-8b6a-00000000e004");
      assert.equal(hits, 1);
      assert.deepEqual(
        bad.map((o) => [o.status, o.reply, o.handoff]),
        ok.map((o) => [o.status, o.reply, o.handoff]),
      );
    } finally {
      globalThis.fetch = realFetch;
      console.warn = orig;
    }
  });

  it("sendAlert throwing -> still 200", async () => {
    const orig = console.warn;
    console.warn = () => {};
    try {
      const out = await runChat(
        {
          store: createMemoryChatStore(),
          catalog: offlineCatalog(),
          sendAlert: async () => {
            throw new Error("boom");
          },
        },
        HANDOFF,
        "3f2b8c1e-9a4d-4e2f-8b6a-00000000e006",
      );
      assert.ok(out.every((o) => o.status === 200));
    } finally {
      console.warn = orig;
    }
  });

  it("waitUntil available -> reply returns without waiting for the send; task handed to waitUntil", async () => {
    const pending: Promise<unknown>[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let sent = 0;
    const deps = {
      store: createMemoryChatStore(),
      catalog: offlineCatalog(),
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      sendAlert: async () => {
        await gate;
        sent += 1;
        return { sent: true, channel: "email" as const };
      },
    };
    const out = await runChat(deps, HANDOFF, "3f2b8c1e-9a4d-4e2f-8b6a-00000000e007");
    assert.equal(out[out.length - 1]!.status, 200);
    assert.equal(pending.length, 1);
    assert.equal(sent, 0);
    release();
    await Promise.all(pending);
    assert.equal(sent, 1);
  });
});
