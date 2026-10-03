/**
 * LB-7: the lead alert email must reach Shiva for real conversations.
 *  - fires as soon as name + valid number are captured (visitors often stop
 *    replying before city / pair / delivery / timeline)
 *  - only alerts that actually went out count toward the phone / IP caps
 *    (mode-off tests and failed Resend calls used to suppress the next alert)
 *  - a successful send leaves a positive log line
 * All values are fakes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCatalogLoader, type CatalogLoader } from "./catalog.ts";
import { handleChatRequest } from "./http.ts";
import { sendLeadAlert, type AlertFetch, type LeadForAlert, type TranscriptLine } from "./lead-alert.ts";
import { createMemoryChatStore } from "./store.ts";

const EMAIL_ENV = { CHAT_LEAD_ALERT_MODE: "email", RESEND_API_KEY: "re_test_FAKEKEY_lb7", CHAT_LEAD_ALERT_EMAIL_TO: "owner@example.com" };
const FULL = ["Talk to Shiva", "Ravi", "9845012345", "Kochi", "single", "train", "ready now"];
const STOP_AFTER_NUMBER = ["Talk to Shiva", "Ravi", "9845012345"];

function offlineCatalog(): CatalogLoader {
  return createCatalogLoader({ fetch: async () => ({ ok: false, status: 500, text: async () => "" }) });
}

function sid(n: number): string {
  return `3f2b8c1e-9a4d-4e2f-8b6a-${String(n).padStart(12, "0")}`;
}

function recorder(status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: AlertFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status < 300,
      status,
      text: async () => (status < 300 ? '{"id":"em_fake_123"}' : '{"statusCode":403,"message":"You can only send testing emails to your own email address"}'),
    };
  };
  return { calls, fetchImpl };
}

async function runChat(deps: Parameters<typeof handleChatRequest>[1], msgs: string[], id: string, ip = "203.0.113.70") {
  const out: Array<{ status: number; reply: string; handoff: boolean }> = [];
  for (const message of msgs) {
    const req = new Request("https://thediscusden.com/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://thediscusden.com", "x-forwarded-for": ip },
      body: JSON.stringify({ sessionId: id, source: "site", message }),
    });
    const res = await handleChatRequest(req, deps);
    out.push({ status: res.status, ...((await res.json()) as { reply: string; handoff: boolean }) });
  }
  return out;
}

async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const [l, w] = [console.log, console.warn];
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    return { result: await fn(), logs };
  } finally {
    console.log = l;
    console.warn = w;
  }
}

function emailDeps(store: ReturnType<typeof createMemoryChatStore>, fetchImpl: AlertFetch, env: Record<string, string> = EMAIL_ENV) {
  return {
    store,
    catalog: offlineCatalog(),
    env: { CHAT_IP_SALT: "lb7-salt", ...env },
    sendAlert: (l: LeadForAlert, t: TranscriptLine[]) => sendLeadAlert(l, t, env, fetchImpl),
  };
}

describe("LB-7 · alert fires when the lead is actionable", () => {
  it("visitor gives name + number then stops replying -> one email on the number turn", async () => {
    const { calls, fetchImpl } = recorder();
    const store = createMemoryChatStore();
    const { result: out } = await quiet(() => runChat(emailDeps(store, fetchImpl), STOP_AFTER_NUMBER, sid(7001)));
    assert.ok(out.every((o) => o.status === 200));
    assert.equal(calls.length, 1);
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.match(body.subject, /^New chat lead: Ravi — /);
    assert.match(body.text, /Phone\/WhatsApp: \+919845012345/);
    assert.equal(store.leads.get(sid(7001))?.alertStatus, "sent");
    // The handoff itself carries on normally (asks for the city next).
    assert.match(out[2]!.reply, /city/i);
    for (const o of out) assert.doesNotMatch(o.reply, /9845012345/);
  });

  it("full handoff -> still exactly one email (not one at the number and another at the end)", async () => {
    const { calls, fetchImpl } = recorder();
    const { result: out } = await quiet(() => runChat(emailDeps(createMemoryChatStore(), fetchImpl), [...FULL, "thanks", "Talk to Shiva"], sid(7002)));
    assert.ok(out.every((o) => o.status === 200));
    assert.equal(calls.length, 1);
  });

  it("name only, no number -> no email", async () => {
    const { calls, fetchImpl } = recorder();
    await quiet(() => runChat(emailDeps(createMemoryChatStore(), fetchImpl), ["Talk to Shiva", "Ravi", "I'd rather not share"], sid(7003)));
    assert.equal(calls.length, 0);
  });

  it("successful send logs a positive line with the Resend id, never the key or the number", async () => {
    const { fetchImpl } = recorder();
    const { logs } = await quiet(() => runChat(emailDeps(createMemoryChatStore(), fetchImpl), STOP_AFTER_NUMBER, sid(7004)));
    assert.ok(logs.some((l) => l === "[chat] lead alert sent: email via Resend id=em_fake_123"), logs.join("\n"));
    for (const l of logs) {
      assert.doesNotMatch(l, /re_test_FAKEKEY_lb7/);
      assert.doesNotMatch(l, /9845012345/);
    }
  });
});

describe("LB-7 · only real sends count toward the caps", () => {
  it("earlier test leads with mode off (same number, same IP) do not suppress the first email-mode lead", async () => {
    const store = createMemoryChatStore();
    const off = recorder();
    await quiet(async () => {
      await runChat(emailDeps(store, off.fetchImpl, {}), FULL, sid(7101));
      await runChat(emailDeps(store, off.fetchImpl, {}), FULL, sid(7102));
      await runChat(emailDeps(store, off.fetchImpl, {}), FULL, sid(7103));
    });
    assert.equal(off.calls.length, 0);
    assert.deepEqual(store.alerts.map((a) => a.status), ["not_sent_off", "not_sent_off", "not_sent_off"]);

    const on = recorder();
    await quiet(() => runChat(emailDeps(store, on.fetchImpl), FULL, sid(7104)));
    assert.equal(on.calls.length, 1);
    assert.equal(store.leads.get(sid(7104))?.alertStatus, "sent");
  });

  it("Resend 403 -> recorded as failed, logged, and the retry lead with the same number still emails", async () => {
    const store = createMemoryChatStore();
    const bad = recorder(403);
    const { logs } = await quiet(() => runChat(emailDeps(store, bad.fetchImpl), FULL, sid(7201)));
    assert.equal(bad.calls.length, 1);
    assert.equal(store.leads.get(sid(7201))?.alertStatus, "failed");
    assert.ok(logs.some((l) => /lead alert failed: Resend HTTP 403/.test(l)));

    const good = recorder();
    await quiet(() => runChat(emailDeps(store, good.fetchImpl), FULL, sid(7202)));
    assert.equal(good.calls.length, 1);
  });

  it("missing RESEND_API_KEY -> failed (not sent), next lead not suppressed", async () => {
    const store = createMemoryChatStore();
    const r = recorder();
    await quiet(() => runChat(emailDeps(store, r.fetchImpl, { CHAT_LEAD_ALERT_MODE: "email", CHAT_LEAD_ALERT_EMAIL_TO: "owner@example.com" }), FULL, sid(7301)));
    assert.equal(r.calls.length, 0);
    assert.equal(store.alerts[0]?.status, "failed");
    await quiet(() => runChat(emailDeps(store, r.fetchImpl), FULL, sid(7302)));
    assert.equal(r.calls.length, 1);
  });

  it("a real sent alert still dedupes the same number within 24 h", async () => {
    const store = createMemoryChatStore();
    const r = recorder();
    await quiet(async () => {
      await runChat(emailDeps(store, r.fetchImpl), FULL, sid(7401));
      await runChat(emailDeps(store, r.fetchImpl), FULL, sid(7402));
    });
    assert.equal(r.calls.length, 1);
    assert.equal(store.leads.get(sid(7402))?.alertStatus, "suppressed_duplicate");
  });

  it("sendAlert throwing -> recorded as failed", async () => {
    const store = createMemoryChatStore();
    await quiet(() =>
      runChat(
        { store, catalog: offlineCatalog(), sendAlert: async () => { throw new Error("boom"); } },
        STOP_AFTER_NUMBER,
        sid(7501),
      ),
    );
    assert.equal(store.alerts[0]?.status, "failed");
  });
});
