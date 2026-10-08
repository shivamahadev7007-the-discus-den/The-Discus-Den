/**
 * LB-19 (Shiva, 8 Oct 2026; final spec 11:37): ONE email per chat, sent when the chat
 * ends, with the full transcript. Tagged Lead (name + valid mobile captured) or Visitor.
 * A chat ends on POST /api/chat/end, after 10 min idle (swept on other requests, or by
 * the daily cron), or with the bot's closing message. Failed / capped chats go to the
 * daily digest. Every scenario runs twice: on the in-memory store AND on the real
 * Postgres store (createSqlChatStore on PGlite with migrations/*.sql applied) - the
 * DB path is what hid LB-7.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { CatalogLoader } from "./catalog.ts";
import { CHAT_IDLE_MS, handleChatCron, handleChatEnd, handleChatRequest, type ChatDeps } from "./http.ts";
import { buildLeadAlertEmail, sendLeadAlert, type AlertFetch, type DigestItem, type LeadAlertResult, type LeadForAlert, type TranscriptLine } from "./lead-alert.ts";
import { createMemoryChatStore, createSqlChatStore, type ChatRow, type ChatStore } from "./store.ts";

const catalog: CatalogLoader = {
  strains: async () => [{ name: "Blue Diamonds (Big)", size: "4.5 inch", price: "₹3,750", priceValue: 3750, available: true, description: "Electric blue." }] as never,
  foods: async () => ({ frozen: [], pellets: [] }) as never,
};
const ORIGIN = "https://thediscusden.com";
const T0 = Date.UTC(2026, 9, 8, 6, 0, 0);
const MIN = 60_000;

function sid(n: number): string {
  return `3f2b8c1e-9a4d-4e2f-8b6a-${String(n).padStart(12, "0")}`;
}

type Harness = {
  store: ChatStore;
  chats: () => Promise<ChatRow[]>;
  close: () => Promise<void>;
};

async function memoryHarness(): Promise<Harness> {
  const store = createMemoryChatStore();
  return { store, chats: async () => [...store.chats.values()].map((c) => ({ ...c })), close: async () => undefined };
}

/** Real Postgres (PGlite), schema = every migrations/*.sql in order, exactly like production. */
async function pgHarness(): Promise<Harness> {
  const pg = new PGlite();
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await pg.exec(readFileSync(join(dir, f), "utf8"));
  const sql = { query: async <T,>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows };
  const store = createSqlChatStore(async () => sql);
  return {
    store,
    chats: async () => {
      const rows = await sql.query<{ id: string }>("select id from chat_conversations order by started_at, id");
      return Promise.all(rows.map(async (r) => (await store.getChat(String(r.id)))!));
    },
    close: () => pg.close(),
  };
}

type Sent = { lead: LeadForAlert; transcript: TranscriptLine[] };

function makeDeps(h: Harness, clock: { t: number }, opts: { fail?: boolean; env?: Record<string, string> } = {}) {
  const sent: Sent[] = [];
  const digests: DigestItem[][] = [];
  let failNext = opts.fail ?? false;
  let digestFails = false;
  const deps: ChatDeps = {
    store: h.store,
    catalog,
    env: { CHAT_IP_SALT: "lb19", ...(opts.env ?? {}) },
    now: () => clock.t,
    sendAlert: async (lead, transcript): Promise<LeadAlertResult> => {
      if (failNext) return { sent: false, channel: "email", error: "http 500" };
      sent.push({ lead, transcript });
      return { sent: true, channel: "email" };
    },
    sendDigest: async (items) => {
      if (digestFails) return { sent: false, channel: "email", error: "http 503" };
      digests.push(items);
      return { sent: true, channel: "email" };
    },
  };
  return {
    deps,
    sent,
    digests,
    setFail: (v: boolean) => (failNext = v),
    setDigestFail: (v: boolean) => (digestFails = v),
  };
}

async function say(deps: ChatDeps, id: string, message: string, ip = "203.0.113.19") {
  const res = await handleChatRequest(
    new Request(`${ORIGIN}/api/chat`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": ip }, body: JSON.stringify({ sessionId: id, message, source: "insta" }) }),
    deps,
  );
  assert.equal(res.status, 200, message);
  return ((await res.json()) as { reply: string }).reply;
}
async function end(deps: ChatDeps, id: string, opts: { type?: string; origin?: string | null; body?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { "content-type": opts.type ?? "text/plain;charset=UTF-8", "x-forwarded-for": opts.ip ?? "203.0.113.19" };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  return handleChatEnd(new Request(`${ORIGIN}/api/chat/end`, { method: "POST", headers, body: opts.body ?? JSON.stringify({ sessionId: id }) }), deps);
}
async function cron(deps: ChatDeps, auth?: string) {
  return handleChatCron(new Request(`${ORIGIN}/api/chat/cron`, { method: "GET", headers: auth ? { authorization: auth } : {} }), deps);
}
async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const [l, w, e] = [console.log, console.warn, console.error];
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.warn = console.log;
  console.error = console.log;
  try {
    return { result: await fn(), logs };
  } finally {
    console.log = l;
    console.warn = w;
    console.error = e;
  }
}
const subjectOf = (s: Sent) => buildLeadAlertEmail(s.lead, s.transcript, { to: "owner@example.com" }).subject;

for (const [label, make] of [["memory store", memoryHarness], ["Postgres store (PGlite + migrations)", pgHarness]] as const) {
  describe(`LB-19 · one email per chat at chat end · ${label}`, () => {
    it("a number typed mid-chat sends NOTHING until the chat ends; /end sends one Lead email with the full transcript", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, sent } = makeDeps(h, clock);
      await quiet(async () => {
        await say(deps, sid(1), "price of blue diamond?");
        await say(deps, sid(1), "9845012345");
        assert.equal(sent.length, 0, "no instant email (Shiva, 11:37)");
        await say(deps, sid(1), "Ravi");
      });
      // "Ravi" completes name + number -> the closing message ends the chat and emails it.
      assert.equal(sent.length, 1);
      const s = sent[0]!;
      assert.match(subjectOf(s), /^\[Lead\] New chat lead: Ravi/);
      assert.equal(s.transcript.length, 6, "full transcript: 3 visitor + 3 bot lines");
      assert.equal(s.lead.chat?.endReason, "closing");
      assert.equal(s.lead.source, "insta");
      const [row] = await h.chats();
      assert.equal(row!.emailStatus, "sent");
      assert.equal(row!.emailKind, "lead");
      assert.equal(row!.phone, "+919845012345");
      await h.close();
    });

    it("no name + number -> Visitor email at /end; a second /end is a no-op (idempotent, 204)", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, sent } = makeDeps(h, clock);
      await quiet(async () => {
        await say(deps, sid(2), "hi");
        await say(deps, sid(2), "do you ship to Kochi?");
        clock.t += MIN;
        assert.equal((await end(deps, sid(2))).status, 204);
        assert.equal((await end(deps, sid(2))).status, 204);
        assert.equal((await end(deps, sid(2), { type: "application/json" })).status, 204);
      });
      assert.equal(sent.length, 1);
      assert.match(subjectOf(sent[0]!), /^\[Visitor\] Website chat: Unnamed visitor/);
      assert.equal(sent[0]!.transcript.length, 4);
      assert.equal(sent[0]!.lead.chat?.endReason, "beacon");
      await h.close();
    });

    it("a phone without a name is still a Visitor (Lead needs name + number), with the phone shown", async () => {
      const h = await make();
      const { deps, sent } = makeDeps(h, { t: T0 });
      await quiet(async () => {
        await say(deps, sid(3), "9845012345");
        await say(deps, sid(3), "do you ship to Kochi?");
        await end(deps, sid(3));
      });
      assert.equal(sent.length, 1);
      const email = buildLeadAlertEmail(sent[0]!.lead, sent[0]!.transcript, { to: "x@example.com" });
      assert.match(email.subject, /^\[Visitor\]/);
      assert.match(email.text, /Phone: {7}\+919845012345/);
      await h.close();
    });

    it("name + city without a valid mobile -> Visitor · likely genuine", async () => {
      const h = await make();
      const { deps, sent } = makeDeps(h, { t: T0 });
      await quiet(async () => {
        await say(deps, sid(4), "my name is Ravi");
        await say(deps, sid(4), "I live in Bangalore");
        await say(deps, sid(4), "98450 1234");
        await end(deps, sid(4));
      });
      const email = buildLeadAlertEmail(sent[0]!.lead, sent[0]!.transcript, { to: "x@example.com" });
      assert.match(email.subject, /^\[Visitor · likely genuine\] Website chat: Ravi/);
      assert.match(email.text, /failed the 10-digit mobile check/);
      await h.close();
    });

    it("10 min idle: another visitor's request sweeps the chat and emails it (Visitor, idle)", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, sent } = makeDeps(h, clock);
      await quiet(async () => {
        await say(deps, sid(5), "price of blue diamond?");
        clock.t += 9 * MIN;
        await say(deps, sid(6), "hi");
        assert.equal(sent.length, 0, "9 min is not idle yet");
        clock.t += 2 * MIN;
        await say(deps, sid(7), "hello");
      });
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.lead.sessionId, sid(5));
      assert.equal(sent[0]!.lead.chat?.endReason, "idle");
      assert.equal(CHAT_IDLE_MS, 10 * MIN);
      await h.close();
    });

    it("returning visitor: same session after the chat ended -> NEW chat (new id) -> its own email, transcript of that chat only", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, sent } = makeDeps(h, clock);
      await quiet(async () => {
        await say(deps, sid(8), "Can I visit the store?");
        await say(deps, sid(8), "yes");
        await say(deps, sid(8), "Ravi");
        await say(deps, sid(8), "fish");
        await say(deps, sid(8), "9845012345");
        await say(deps, sid(8), "Chennai");
        await say(deps, sid(8), "I'll visit");
        await say(deps, sid(8), "ready now"); // closing message -> chat 1 ends + emails
        await say(deps, sid(8), "thanks"); // courtesy right after the close stays in chat 1, no email
        clock.t += 3 * 24 * 60 * MIN; // back three days later, same browser session id
        await say(deps, sid(8), "do you have blue diamond?");
        await say(deps, sid(8), "price?");
        await end(deps, sid(8));
      });
      assert.equal(sent.length, 2);
      assert.notEqual(sent[0]!.lead.chat!.id, sent[1]!.lead.chat!.id);
      assert.match(subjectOf(sent[0]!), /^\[Lead\]/);
      // Chat 2: no number typed in it -> Visitor, but Shiva sees the earlier details.
      assert.match(subjectOf(sent[1]!), /^\[Visitor\]/);
      assert.equal(sent[1]!.transcript.length, 4);
      assert.ok(!sent[1]!.transcript.some((l) => /9845012345/.test(l.text)));
      assert.match(buildLeadAlertEmail(sent[1]!.lead, sent[1]!.transcript, { to: "x@example.com" }).text, /Earlier chat: Ravi, \+919845012345/);
      assert.ok(sent[0]!.transcript.some((l) => l.text === "thanks") === false, "chat 1 email went out at the close");
      assert.equal((await h.chats()).length, 2);
      await h.close();
    });

    it("the visitor's own idle chat: next message 11 min later ends + emails the old chat and starts a new one", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, sent } = makeDeps(h, clock);
      await quiet(async () => {
        await say(deps, sid(9), "price of blue diamond?");
        clock.t += 11 * MIN;
        await say(deps, sid(9), "hi again");
      });
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.transcript.length, 2);
      const rows = await h.chats();
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.endReason, "idle");
      assert.equal(rows[1]!.endedAt, null);
      await h.close();
    });

    it("Resend failure -> not marked sent, logged, picked up by the daily digest, then marked; next digest is empty", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, sent, digests, setFail } = makeDeps(h, clock, { fail: true });
      const { logs } = await quiet(async () => {
        await say(deps, sid(10), "price of blue diamond?");
        await end(deps, sid(10));
      });
      assert.equal(sent.length, 0);
      assert.ok(logs.some((l) => /\[chat\] lead alert skipped: send failed \(http 500\)/.test(l)), logs.join("\n"));
      assert.equal((await h.chats())[0]!.emailStatus, "failed");
      setFail(false);
      clock.t += 5 * MIN;
      const res = await quiet(() => cron(deps));
      assert.equal(res.result.status, 200);
      assert.equal(digests.length, 1);
      assert.equal(digests[0]!.length, 1);
      assert.equal(digests[0]![0]!.status, "failed");
      assert.equal(digests[0]![0]!.transcript.length, 2);
      const row = (await h.chats())[0]!;
      assert.equal(row.emailStatus, "sent");
      assert.equal(row.emailVia, "digest");
      await quiet(() => cron(deps));
      assert.equal(digests.length, 1, "nothing left for the next digest");
      await h.close();
    });

    it("digest send failure keeps the chats queued for tomorrow", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, digests, setFail, setDigestFail } = makeDeps(h, clock, { fail: true });
      await quiet(async () => {
        await say(deps, sid(11), "price of blue diamond?");
        await end(deps, sid(11));
      });
      setFail(false);
      setDigestFail(true);
      clock.t += 5 * MIN;
      const { logs } = await quiet(() => cron(deps));
      assert.ok(logs.some((l) => /lead alert skipped: digest not sent/.test(l)));
      assert.equal((await h.chats())[0]!.emailStatus, "failed");
      setDigestFail(false);
      clock.t += 24 * 60 * MIN;
      await quiet(() => cron(deps));
      assert.equal(digests.length, 1);
      assert.equal((await h.chats())[0]!.emailStatus, "sent");
      await h.close();
    });

    it("caps: over the hourly cap the chat is recorded 'capped' (logged), never lost, and the digest lists it", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, sent, digests } = makeDeps(h, clock, { env: { CHAT_ALERT_GLOBAL_CAP_HOUR: "1" } });
      const { logs } = await quiet(async () => {
        await say(deps, sid(12), "price of blue diamond?", "198.51.100.1");
        await end(deps, sid(12), { ip: "198.51.100.1" });
        await say(deps, sid(13), "I'm Asha 9845012399", "198.51.100.2");
      });
      assert.equal(sent.length, 1);
      assert.ok(logs.some((l) => /\[chat\] lead alert skipped: global_cap .*kind=lead .*daily digest/.test(l)), logs.join("\n"));
      const capped = (await h.chats()).find((c) => c.sessionId === sid(13))!;
      assert.equal(capped.emailStatus, "capped");
      clock.t += 5 * MIN;
      await quiet(() => cron(deps));
      assert.equal(digests[0]!.length, 1);
      assert.equal(digests[0]![0]!.lead.state.lead.name, "Asha");
      assert.equal(digests[0]![0]!.status, "capped");
      await h.close();
    });

    it("the daily cron ends idle chats nobody swept and digests them; CRON_SECRET enforced when set", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, digests } = makeDeps(h, clock, { env: { CRON_SECRET: "s3cret" } });
      await quiet(async () => {
        await say(deps, sid(14), "do you ship to Kochi?");
        await say(deps, sid(15), "Ravi 9845012345");
      });
      clock.t += 6 * 60 * MIN;
      assert.equal((await cron(deps)).status, 401);
      assert.equal((await cron(deps, "Bearer nope")).status, 401);
      const { result } = await quiet(() => cron(deps, "Bearer s3cret"));
      assert.equal(result.status, 200);
      const body = (await result.json()) as { ended: number; digested: number };
      assert.equal(body.ended, 1, "sid 15 already ended with its closing message");
      assert.equal(digests.length, 0, "sid 15 was emailed at its close; sid 14 just ended -> settles before digest");
      clock.t += 2 * MIN;
      await quiet(() => cron(deps, "Bearer s3cret"));
      assert.equal(digests.length, 1);
      assert.deepEqual(digests[0]!.map((d) => d.lead.sessionId), [sid(14)]);
      await h.close();
    });

    it("a claim stuck by a frozen isolate is retried by the digest after it goes stale", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, digests } = makeDeps(h, clock);
      await quiet(() => say(deps, sid(16), "price of blue diamond?"));
      const chat = (await h.chats())[0]!;
      await h.store.endChat(chat.id, "beacon", clock.t);
      assert.ok(await h.store.claimChatEmail({ chatId: chat.id, nowMs: clock.t, retryFailed: false }), "claimed, then the isolate 'dies'");
      assert.equal(await h.store.claimChatEmail({ chatId: chat.id, nowMs: clock.t + 1000, retryFailed: true }), null, "a fresh claim blocks double sends");
      clock.t += 3 * MIN;
      await quiet(() => cron(deps));
      assert.equal(digests.length, 1);
      assert.equal((await h.chats())[0]!.emailStatus, "sent");
      await h.close();
    });

    it("/end: text/plain + JSON accepted, CORS like /api/chat, bad origin 403, bad body 400, unknown session 204", async () => {
      const h = await make();
      const { deps } = makeDeps(h, { t: T0 });
      const ok = await end(deps, sid(17));
      assert.equal(ok.status, 204);
      assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
      assert.equal((await end(deps, sid(17), { origin: "https://evil.example" })).status, 403);
      assert.equal((await end(deps, sid(17), { body: "not json" })).status, 400);
      assert.equal((await end(deps, sid(17), { body: JSON.stringify({ sessionId: "nope" }) })).status, 400);
      assert.equal((await end(deps, sid(17), { origin: null })).status, 204);
      const pre = await handleChatEnd(new Request(`${ORIGIN}/api/chat/end`, { method: "OPTIONS", headers: { origin: ORIGIN } }), deps);
      assert.equal(pre.status, 204);
      await h.close();
    });

    it("messages carry their chat id; transcripts never mix chats", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps } = makeDeps(h, clock);
      await quiet(async () => {
        await say(deps, sid(18), "hi");
        await end(deps, sid(18));
        await say(deps, sid(18), "price of blue diamond?");
      });
      const rows = await h.chats();
      assert.equal(rows.length, 2);
      assert.equal((await h.store.chatTranscript(rows[0]!.id)).length, 2);
      assert.equal((await h.store.chatTranscript(rows[1]!.id))[0]!.text, "price of blue diamond?");
      await h.close();
    });
  });
}

describe("LB-19 · email content and Resend call", () => {
  it("Lead email: tag, name, phone, city, source, timestamps, transcript; idempotency key per CHAT", async () => {
    const h = await memoryHarness();
    const clock = { t: T0 };
    const calls: Array<{ init: RequestInit }> = [];
    const fetchImpl: AlertFetch = async (_u, init) => {
      calls.push({ init });
      return { ok: true, status: 200, text: async () => '{"id":"em_1"}' };
    };
    const env = { CHAT_LEAD_ALERT_MODE: "email", RESEND_API_KEY: "re_x", CHAT_LEAD_ALERT_EMAIL_TO: "owner@example.com" };
    const deps: ChatDeps = { store: h.store, catalog, env, now: () => clock.t, sendAlert: (l, t) => sendLeadAlert(l, t, env, fetchImpl) };
    await quiet(async () => {
      await say(deps, sid(30), "I live in Kochi");
      await say(deps, sid(30), "I'm Ravi, 98450 12345");
      clock.t += 4 * 24 * 60 * MIN;
      await say(deps, sid(30), "Ravi again 98450 12345");
    });
    assert.equal(calls.length, 2, "one per chat, returning customer included");
    const keys = calls.map((c) => (c.init.headers as Record<string, string>)["Idempotency-Key"]);
    assert.notEqual(keys[0], keys[1], "per-chat key: Resend must not dedupe the returning visitor's email");
    assert.match(keys[0]!, /^tdd-chat-[0-9a-f-]{36}$/);
    const body = JSON.parse(String(calls[0]!.init.body)) as { subject: string; text: string };
    assert.match(body.subject, /^\[Lead\] New chat lead: Ravi/);
    for (const re of [/Tag: {9}Lead/, /Name: {8}Ravi/, /Phone: {7}\+919845012345/, /City: {8}Kerala/ /* engine stores Kochi as its state */, /Source: {6}\?from=insta/, /Chat started: 08 Oct 2026, 11:30 IST/, /Chat ended: {3}08 Oct 2026, 11:30 IST \(closing message/, /Visitor: I live in Kochi/, /Visitor: I'm Ravi, 98450 12345/]) {
      assert.match(body.text, re);
    }
  });
});
