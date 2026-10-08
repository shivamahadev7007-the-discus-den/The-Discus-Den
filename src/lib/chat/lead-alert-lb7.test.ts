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
import { handleChatEnd, handleChatRequest } from "./http.ts";
import { sendLeadAlert, type AlertFetch, type LeadForAlert, type TranscriptLine } from "./lead-alert.ts";
import { createMemoryChatStore } from "./store.ts";

const EMAIL_ENV = { CHAT_LEAD_ALERT_MODE: "email", RESEND_API_KEY: "re_test_FAKEKEY_lb7", CHAT_LEAD_ALERT_EMAIL_TO: "owner@example.com" };
/** LB-6: "Talk to Shiva" now steers to the site; a genuine handoff opens via a store visit. */
const OPEN = ["Can I visit the store?", "yes"];
const FULL = [...OPEN, "Ravi", "fish", "9845012345", "Kochi", "train", "ready now"];
const STOP_AFTER_NUMBER = [...OPEN, "Ravi", "fish", "9845012345"];

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

/** LB-19: the widget's close / pagehide beacon (POST /api/chat/end). */
async function endChat(deps: Parameters<typeof handleChatEnd>[1], id: string, ip = "203.0.113.70") {
  const req = new Request("https://thediscusden.com/api/chat/end", {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8", origin: "https://thediscusden.com", "x-forwarded-for": ip },
    body: JSON.stringify({ sessionId: id }),
  });
  return handleChatEnd(req, deps);
}

/** LB-19 fix (Kiara #2): a whole chat, then the widget's /end (the email goes at chat end, not at the closing message). */
async function runAndEnd(deps: Parameters<typeof handleChatRequest>[1], msgs: string[], id: string, ip = "203.0.113.70") {
  const out = await runChat(deps, msgs, id, ip);
  await endChat(deps, id, ip);
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
  // LB-19 (Shiva, 8 Oct 11:37): no email on the number turn any more; ONE email when the chat ends.
  it("visitor gives name + number then closes the chat -> no email on the number turn, one Lead email at /end", async () => {
    const { calls, fetchImpl } = recorder();
    const store = createMemoryChatStore();
    const deps = emailDeps(store, fetchImpl);
    const { result: out } = await quiet(() => runChat(deps, STOP_AFTER_NUMBER, sid(7001)));
    assert.ok(out.every((o) => o.status === 200));
    assert.equal(calls.length, 0, "nothing sent while the chat is open");
    await quiet(() => endChat(deps, sid(7001)));
    assert.equal(calls.length, 1);
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.match(body.subject, /^\[Lead\] New chat lead: Ravi — /);
    assert.match(body.text, /visitor closed the chat/);
    assert.match(body.text, /Phone\/WhatsApp: \+919845012345/);
    assert.equal(store.leads.get(sid(7001))?.alertStatus, "sent");
    // The handoff itself carries on normally (asks for the city next).
    assert.match(out.at(-1)!.reply, /city/i);
    for (const o of out) assert.doesNotMatch(o.reply, /9845012345/);
  });

  it("full handoff -> still exactly one email (not one at the number and another at the end)", async () => {
    const { calls, fetchImpl } = recorder();
    const { result: out } = await quiet(() => runAndEnd(emailDeps(createMemoryChatStore(), fetchImpl), [...FULL, "thanks", "Can I visit the store?"], sid(7002)));
    assert.ok(out.every((o) => o.status === 200));
    assert.equal(calls.length, 1);
  });

  it("name only, no number -> no email", async () => {
    const { calls, fetchImpl } = recorder();
    await quiet(() => runChat(emailDeps(createMemoryChatStore(), fetchImpl), [...OPEN, "Ravi", "I'd rather not share"], sid(7003)));
    assert.equal(calls.length, 0);
  });

  it("successful send logs a positive line with the Resend id, never the key or the number", async () => {
    const { fetchImpl } = recorder();
    const deps = emailDeps(createMemoryChatStore(), fetchImpl);
    const { logs } = await quiet(async () => {
      await runChat(deps, STOP_AFTER_NUMBER, sid(7004));
      await endChat(deps, sid(7004));
    });
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
      await runAndEnd(emailDeps(store, off.fetchImpl, {}), FULL, sid(7101));
      await runAndEnd(emailDeps(store, off.fetchImpl, {}), FULL, sid(7102));
      await runAndEnd(emailDeps(store, off.fetchImpl, {}), FULL, sid(7103));
    });
    assert.equal(off.calls.length, 0);
    assert.deepEqual(store.alerts.map((a) => a.status), ["not_sent_off", "not_sent_off", "not_sent_off"]);

    const on = recorder();
    await quiet(() => runAndEnd(emailDeps(store, on.fetchImpl), FULL, sid(7104)));
    assert.equal(on.calls.length, 1);
    assert.equal(store.leads.get(sid(7104))?.alertStatus, "sent");
  });

  it("Resend 403 -> recorded as failed, logged, and the retry lead with the same number still emails", async () => {
    const store = createMemoryChatStore();
    const bad = recorder(403);
    const { logs } = await quiet(() => runAndEnd(emailDeps(store, bad.fetchImpl), FULL, sid(7201)));
    assert.equal(bad.calls.length, 1);
    assert.equal(store.leads.get(sid(7201))?.alertStatus, "failed");
    assert.ok(logs.some((l) => /lead alert failed: Resend HTTP 403/.test(l)));

    const good = recorder();
    await quiet(() => runAndEnd(emailDeps(store, good.fetchImpl), FULL, sid(7202)));
    assert.equal(good.calls.length, 1);
  });

  it("missing RESEND_API_KEY -> failed (not sent), next lead not suppressed", async () => {
    const store = createMemoryChatStore();
    const r = recorder();
    await quiet(() => runAndEnd(emailDeps(store, r.fetchImpl, { CHAT_LEAD_ALERT_MODE: "email", CHAT_LEAD_ALERT_EMAIL_TO: "owner@example.com" }), FULL, sid(7301)));
    assert.equal(r.calls.length, 0);
    assert.equal(store.alerts[0]?.status, "failed");
    await quiet(() => runAndEnd(emailDeps(store, r.fetchImpl), FULL, sid(7302)));
    assert.equal(r.calls.length, 1);
  });

  // LB-19 (8 Oct): the per-phone 24 h dedupe is gone - 1 chat = 1 email, returning customers included.
  it("the same number in another chat within 24 h emails again (one per chat)", async () => {
    const store = createMemoryChatStore();
    const r = recorder();
    await quiet(async () => {
      await runAndEnd(emailDeps(store, r.fetchImpl), FULL, sid(7401));
      await runAndEnd(emailDeps(store, r.fetchImpl), FULL, sid(7402));
    });
    assert.equal(r.calls.length, 2);
    assert.equal(store.leads.get(sid(7402))?.alertStatus, "sent");
  });

  it("sendAlert throwing -> recorded as failed", async () => {
    const store = createMemoryChatStore();
    const deps = { store, catalog: offlineCatalog(), sendAlert: async () => { throw new Error("boom"); } };
    await quiet(async () => {
      await runChat(deps, STOP_AFTER_NUMBER, sid(7501));
      await endChat(deps, sid(7501));
    });
    assert.equal(store.alerts[0]?.status, "failed");
    assert.equal([...store.chats.values()][0]!.emailStatus, "failed", "released for the digest, never 'sent'");
  });
});
