/**
 * LB-19 (Shiva, 8 Oct 2026; final spec 11:37): ONE email per chat, sent when the chat
 * ends, with the full transcript. Tagged Lead (name + valid mobile captured) or Visitor.
 * A chat ends on POST /api/chat/end, after 10 min idle (swept on other requests, or by
 * the daily cron), or with the bot's closing message. Failed / capped chats go to the
 * daily digest. Every scenario runs twice: on the in-memory store AND on the real
 * Postgres store (createSqlChatStore on PGlite with migrations/*.sql applied) - the
 * DB path is what hid LB-7.
 *
 * LB-19 fix round (Kiara's report, 8 Oct): the closing message keeps the chat open for
 * 10 more quiet minutes (one email, full transcript incl. post-close messages); the cron
 * emails the chats it ends in the same run and fails closed without CRON_SECRET; Leads
 * are never capped and don't count toward the Visitor caps. Time is deterministic: every
 * request advances the injected clock by 1 s, so no two chats ever share a timestamp and
 * nothing depends on uuid order (Kiara #7: the PGlite "transcripts never mix chats" flake).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { ANSWERS } from "./answers.ts";
import type { CatalogLoader } from "./catalog.ts";
import { CHAT_IDLE_MS, CRON_EMAILS, handleChatCron, handleChatEnd, handleChatRequest, type ChatDeps } from "./http.ts";
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
      const rows = await sql.query<{ id: string }>("select id from chat_conversations order by started_at, seq");
      return Promise.all(rows.map(async (r) => (await store.getChat(String(r.id)))!));
    },
    close: () => pg.close(),
  };
}

type Sent = { lead: LeadForAlert; transcript: TranscriptLine[] };

const CRON_SECRET = "s3cret-lb19";
const CLOCKS = new WeakMap<ChatDeps, { t: number }>();
/** Deterministic time: each request is 1 s after the previous one. */
function tick(deps: ChatDeps): void {
  const c = CLOCKS.get(deps);
  if (c) c.t += 1000;
}

function makeDeps(h: Harness, clock: { t: number }, opts: { fail?: boolean; env?: Record<string, string> } = {}) {
  const sent: Sent[] = [];
  const digests: DigestItem[][] = [];
  let failNext = opts.fail ?? false;
  let digestFails = false;
  const deps: ChatDeps = {
    store: h.store,
    catalog,
    env: { CHAT_IP_SALT: "lb19", CRON_SECRET, ...(opts.env ?? {}) },
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
  CLOCKS.set(deps, clock);
  return {
    deps,
    sent,
    digests,
    setFail: (v: boolean) => (failNext = v),
    setDigestFail: (v: boolean) => (digestFails = v),
  };
}

async function say(deps: ChatDeps, id: string, message: string, ip = "203.0.113.19") {
  tick(deps);
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
  tick(deps);
  return handleChatEnd(new Request(`${ORIGIN}/api/chat/end`, { method: "POST", headers, body: opts.body ?? JSON.stringify({ sessionId: id }) }), deps);
}
async function cron(deps: ChatDeps, auth: string | null = `Bearer ${CRON_SECRET}`) {
  tick(deps);
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
    it("Kiara #2 repro: closing message, then 'thanks' + a delivery question -> SAME chat, ONE [Lead] email at /end with all 4 visitor lines", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, sent } = makeDeps(h, clock);
      const replies: string[] = [];
      await quiet(async () => {
        replies.push(await say(deps, sid(1), "What is the price of Blue Diamond?"));
        replies.push(await say(deps, sid(1), "I'm Ravi Kumar, 9876500001"));
        assert.equal(sent.length, 0, "the closing message no longer sends at once");
        replies.push(await say(deps, sid(1), "thanks"));
        replies.push(await say(deps, sid(1), "How many days will delivery to Bangalore take?"));
        assert.equal(sent.length, 0, "no instant email (Shiva, 11:37), no early email at the close");
        assert.equal((await end(deps, sid(1))).status, 204);
        assert.equal((await end(deps, sid(1))).status, 204);
      });
      assert.equal(replies[1], ANSWERS.handoffClose("Ravi Kumar"));
      assert.equal(replies[2], ANSWERS.thanks, "a plain thanks, no 'Discus fish or frozen foods?'");
      assert.equal(sent.length, 1, "exactly one email");
      const s = sent[0]!;
      assert.match(subjectOf(s), /^\[Lead\] New chat lead: Ravi Kumar/);
      assert.deepEqual(
        s.transcript.filter((l) => l.role === "user").map((l) => l.text),
        ["What is the price of Blue Diamond?", "I'm Ravi Kumar, 9876500001", "thanks", "How many days will delivery to Bangalore take?"],
      );
      assert.equal(s.transcript.length, 8);
      assert.equal(s.lead.chat?.endReason, "beacon");
      assert.equal(s.lead.source, "insta");
      const rows = await h.chats();
      assert.equal(rows.length, 1, "no second chat, no second [Visitor] email");
      assert.equal(rows[0]!.emailStatus, "sent");
      assert.equal(rows[0]!.emailKind, "lead");
      assert.equal(rows[0]!.phone, "+919876500001");
      assert.ok(rows[0]!.closedAt !== null, "closing message recorded");
      await h.close();
    });

    it("closing message then silence: messages within 10 min join the chat; it ends 10 min after the LAST message (reason closing) and the next request's sweep emails it", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, sent } = makeDeps(h, clock);
      await quiet(async () => {
        await say(deps, sid(2), "price of blue diamond?");
        await say(deps, sid(2), "Ravi 9876500002");
        clock.t += 9 * MIN;
        await say(deps, sid(2), "one more thing, do you ship to Kochi?");
        clock.t += 9 * MIN;
        await say(deps, sid(3), "hi");
        assert.equal(sent.length, 0, "9 min after the last message: still open");
        clock.t += 2 * MIN;
        await say(deps, sid(4), "hello");
      });
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.lead.sessionId, sid(2));
      assert.equal(sent[0]!.lead.chat?.endReason, "closing");
      assert.equal(sent[0]!.transcript.length, 6, "post-close question included");
      assert.match(buildLeadAlertEmail(sent[0]!.lead, sent[0]!.transcript, { to: "x@example.com" }).text, /closing message after details were collected, then 10 min with no messages/);
      assert.equal((await h.chats()).filter((c) => c.sessionId === sid(2)).length, 1);
      await h.close();
    });

    it("no name + number -> Visitor email at /end; a second /end is a no-op (idempotent, 204)", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, sent } = makeDeps(h, clock);
      await quiet(async () => {
        await say(deps, sid(5), "hi");
        await say(deps, sid(5), "do you ship to Kochi?");
        clock.t += MIN;
        assert.equal((await end(deps, sid(5))).status, 204);
        assert.equal((await end(deps, sid(5))).status, 204);
        assert.equal((await end(deps, sid(5), { type: "application/json" })).status, 204);
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
        await say(deps, sid(6), "9845012345");
        await say(deps, sid(6), "do you ship to Kochi?");
        await end(deps, sid(6));
      });
      assert.equal(sent.length, 1);
      const email = buildLeadAlertEmail(sent[0]!.lead, sent[0]!.transcript, { to: "x@example.com" });
      assert.match(email.subject, /^\[Visitor\]/);
      assert.match(email.text, /Phone: {7}\+919845012345/);
      await h.close();
    });

    it("name + city without a valid mobile -> Visitor · likely genuine; '+91 98765 000' is never saved (Kiara #5)", async () => {
      const h = await make();
      const { deps, sent } = makeDeps(h, { t: T0 });
      await quiet(async () => {
        await say(deps, sid(7), "my name is Ravi");
        await say(deps, sid(7), "I live in Bangalore");
        await say(deps, sid(7), "+91 98765 000");
        await end(deps, sid(7));
      });
      const email = buildLeadAlertEmail(sent[0]!.lead, sent[0]!.transcript, { to: "x@example.com" });
      assert.match(email.subject, /^\[Visitor · likely genuine\] Website chat: Ravi/);
      assert.match(email.text, /failed the 10-digit mobile check/);
      assert.equal((await h.chats())[0]!.phone, null);
      await h.close();
    });

    it("10 min idle: another visitor's request sweeps the chat and emails it (Visitor, idle)", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, sent } = makeDeps(h, clock);
      await quiet(async () => {
        await say(deps, sid(8), "price of blue diamond?");
        clock.t += 9 * MIN;
        await say(deps, sid(9), "hi");
        assert.equal(sent.length, 0, "9 min is not idle yet");
        clock.t += 2 * MIN;
        await say(deps, sid(10), "hello");
      });
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.lead.sessionId, sid(8));
      assert.equal(sent[0]!.lead.chat?.endReason, "idle");
      assert.equal(CHAT_IDLE_MS, 10 * MIN);
      await h.close();
    });

    it("returning visitor: back days later on the same session -> NEW chat -> its own email ([Lead · returning], known name), that chat's lines only", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, sent } = makeDeps(h, clock);
      await quiet(async () => {
        await say(deps, sid(11), "price of blue diamond?");
        await say(deps, sid(11), "I'm Ravi, 9845012345");
        await say(deps, sid(11), "thanks");
        clock.t += 3 * 24 * 60 * MIN; // back three days later, same browser session id
        await say(deps, sid(11), "do you have blue diamond?");
        await say(deps, sid(11), "price?");
        await end(deps, sid(11));
      });
      assert.equal(sent.length, 2);
      assert.notEqual(sent[0]!.lead.chat!.id, sent[1]!.lead.chat!.id);
      assert.match(subjectOf(sent[0]!), /^\[Lead\] New chat lead: Ravi/);
      assert.equal(sent[0]!.lead.chat?.endReason, "closing");
      assert.equal(sent[0]!.transcript.length, 6, "chat 1 incl. the post-close 'thanks'");
      // Chat 2: no number typed in it, but name + number are known from chat 1 (Kiara #2 note).
      assert.match(subjectOf(sent[1]!), /^\[Lead · returning\] Website chat: Ravi — /);
      assert.equal(sent[1]!.transcript.length, 4);
      assert.ok(!sent[1]!.transcript.some((l) => /9845012345/.test(l.text)));
      const text = buildLeadAlertEmail(sent[1]!.lead, sent[1]!.transcript, { to: "x@example.com" }).text;
      assert.match(text, /Earlier chat: Ravi, \+919845012345/);
      assert.match(text, /Phone: {7}\+919845012345 \(from an earlier chat\)/);
      assert.equal((await h.chats()).length, 2);
      await h.close();
    });

    it("the visitor's own idle chat: next message 11 min later ends + emails the old chat and starts a new one", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, sent } = makeDeps(h, clock);
      await quiet(async () => {
        await say(deps, sid(12), "price of blue diamond?");
        clock.t += 11 * MIN;
        await say(deps, sid(12), "hi again");
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
        await say(deps, sid(13), "price of blue diamond?");
        await end(deps, sid(13));
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
        await say(deps, sid(14), "price of blue diamond?");
        await end(deps, sid(14));
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

    it("Kiara #3: over the hourly cap a VISITOR is recorded 'capped' (logged) for the digest, but a LEAD is never capped", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, sent, digests } = makeDeps(h, clock, { env: { CHAT_ALERT_GLOBAL_CAP_HOUR: "1" } });
      const { logs } = await quiet(async () => {
        await say(deps, sid(15), "price of blue diamond?", "198.51.100.1");
        await end(deps, sid(15), { ip: "198.51.100.1" });
        await say(deps, sid(16), "do you ship to Kochi?", "198.51.100.2");
        await end(deps, sid(16), { ip: "198.51.100.2" });
        await say(deps, sid(17), "What is the price of Blue Diamond?", "198.51.100.3");
        await say(deps, sid(17), "Meena, 9876500020", "198.51.100.3");
        await end(deps, sid(17), { ip: "198.51.100.3" });
      });
      assert.equal(sent.length, 2, "Visitor 1 + the Lead");
      assert.equal(sent[1]!.lead.state.lead.name, "Meena");
      assert.ok(logs.some((l) => /\[chat\] lead alert skipped: global_cap .*kind=visitor .*daily digest/.test(l)), logs.join("\n"));
      assert.ok(!logs.some((l) => /skipped: \w+_cap .*kind=lead/.test(l)), "a Lead is never capped");
      const rows = await h.chats();
      assert.equal(rows.find((c) => c.sessionId === sid(16))!.emailStatus, "capped");
      assert.equal(rows.find((c) => c.sessionId === sid(17))!.emailStatus, "sent");
      clock.t += 5 * MIN;
      await quiet(() => cron(deps));
      assert.equal(digests[0]!.length, 1);
      assert.equal(digests[0]![0]!.lead.sessionId, sid(16));
      assert.equal(digests[0]![0]!.status, "capped");
      await h.close();
    });

    it("Kiara #3: Lead emails don't count toward the Visitor per-IP cap (3 Leads, then Visitors from the same IP)", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, sent } = makeDeps(h, clock, { env: { CHAT_ALERT_IP_CAP_24H: "1" } });
      const ip = "198.51.100.77";
      await quiet(async () => {
        for (let i = 0; i < 3; i += 1) {
          await say(deps, sid(20 + i), `I'm Asha, 98765000${30 + i}`, ip);
          await end(deps, sid(20 + i), { ip });
        }
        await say(deps, sid(23), "price of blue diamond?", ip);
        await end(deps, sid(23), { ip });
        await say(deps, sid(24), "do you ship to Kochi?", ip);
        await end(deps, sid(24), { ip });
      });
      assert.equal(sent.length, 4, "3 Leads + the first Visitor");
      const rows = await h.chats();
      assert.equal(rows.find((c) => c.sessionId === sid(23))!.emailStatus, "sent");
      assert.equal(rows.find((c) => c.sessionId === sid(24))!.emailStatus, "capped");
      assert.equal(rows.find((c) => c.sessionId === sid(24))!.emailNote, "ip_cap");
      await h.close();
    });

    it("Kiara #1: the cron emails the chats it ends IN THE SAME RUN (idle Visitor + a closing-message Lead nobody swept)", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, sent, digests } = makeDeps(h, clock);
      await quiet(async () => {
        await say(deps, sid(30), "What is the price of Blue Diamond?");
        await say(deps, sid(31), "price of blue diamond?");
        await say(deps, sid(31), "Ravi 9845012345");
      });
      clock.t += 11 * MIN; // no /end, nobody else chats
      const { result } = await quiet(() => cron(deps));
      assert.equal(result.status, 200);
      const body = (await result.json()) as { ended: number; emailed: number; digested: number };
      assert.equal(body.ended, 2);
      assert.equal(body.emailed, 2);
      assert.equal(body.digested, 0);
      assert.equal(sent.length, 2, "both emailed now, not in tomorrow's digest");
      assert.deepEqual(sent.map((x) => x.lead.chat?.endReason).sort(), ["closing", "idle"]);
      assert.equal(digests.length, 0);
      await quiet(() => cron(deps));
      assert.equal(sent.length, 2, "a later cron sends nothing again");
      await h.close();
    });

    it("cron fails closed: CRON_SECRET unset -> 401 + a clear error, nothing ended or sent; wrong / missing bearer -> 401", async () => {
      const h = await make();
      const clock = { t: T0 };
      const open = makeDeps(h, clock, { env: { CRON_SECRET: "" } });
      await quiet(() => say(open.deps, sid(32), "price of blue diamond?"));
      clock.t += 11 * MIN;
      const { result, logs } = await quiet(() => cron(open.deps));
      assert.equal(result.status, 401);
      assert.ok(logs.some((l) => /cron: REJECTED \(401\) because CRON_SECRET is not set/.test(l)), logs.join("\n"));
      assert.equal(open.sent.length, 0);
      assert.equal((await h.chats())[0]!.endedAt, null, "nothing ended");
      const { deps, sent } = makeDeps(h, clock);
      assert.equal((await quiet(() => cron(deps, null))).result.status, 401);
      assert.equal((await quiet(() => cron(deps, "Bearer nope"))).result.status, 401);
      assert.equal((await quiet(() => cron(deps, CRON_SECRET))).result.status, 401, "the bare secret is not a bearer");
      assert.equal((await quiet(() => cron(deps))).result.status, 200);
      assert.equal(sent.length, 1);
      await h.close();
    });

    it("over the cron's send limit: the rest go into the SAME run's digest", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, sent, digests } = makeDeps(h, clock, { env: { CHAT_ALERT_GLOBAL_CAP_HOUR: "100" } });
      const n = CRON_EMAILS.limit + 2;
      await quiet(async () => {
        for (let i = 0; i < n; i += 1) await say(deps, sid(100 + i), "price of blue diamond?", `198.51.${100 + Math.floor(i / 2)}.${i % 2}`);
      });
      clock.t += 11 * MIN;
      const { result } = await quiet(() => cron(deps));
      const body = (await result.json()) as { ended: number; emailed: number; digested: number };
      assert.equal(body.ended, n);
      assert.equal(body.emailed, CRON_EMAILS.limit);
      assert.equal(body.digested, 2);
      assert.equal(sent.length, CRON_EMAILS.limit);
      assert.equal(digests[0]!.length, 2);
      assert.ok((await h.chats()).every((c) => c.emailStatus === "sent"));
      await h.close();
    });

    it("a claim stuck by a frozen isolate is retried after it goes stale (by the cron, and by the per-request sweep)", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, sent, digests } = makeDeps(h, clock);
      await quiet(async () => {
        await say(deps, sid(40), "price of blue diamond?");
        await say(deps, sid(41), "do you ship to Kochi?");
      });
      const [a, b] = await h.chats();
      await h.store.endChat(a!.id, "beacon", clock.t);
      assert.ok(await h.store.claimChatEmail({ chatId: a!.id, nowMs: clock.t, retryFailed: false }), "claimed, then the isolate 'dies'");
      assert.equal(await h.store.claimChatEmail({ chatId: a!.id, nowMs: clock.t + 1000, retryFailed: true }), null, "a fresh claim blocks double sends");
      await h.store.endChat(b!.id, "beacon", clock.t); // ended, never even claimed
      clock.t += MIN;
      await quiet(() => say(deps, sid(42), "hi"));
      assert.equal(sent.length, 0, "not stale yet");
      clock.t += 2 * MIN;
      await quiet(() => say(deps, sid(43), "hi"));
      assert.equal(sent.length, 2, "the sweep picked both up");
      assert.equal(digests.length, 0);
      const rows = await h.chats();
      assert.equal(rows.find((c) => c.id === a!.id)!.emailStatus, "sent");
      assert.equal(rows.find((c) => c.id === b!.id)!.emailStatus, "sent");
      // And the cron does the same with no traffic at all:
      const c = (await h.chats()).find((r) => r.sessionId === sid(42))!;
      await h.store.endChat(c.id, "beacon", clock.t);
      await h.store.claimChatEmail({ chatId: c.id, nowMs: clock.t, retryFailed: false });
      clock.t += 3 * MIN;
      await quiet(() => cron(deps));
      assert.equal(sent.length, 3);
      await h.close();
    });

    it("/end: text/plain + JSON accepted, CORS like /api/chat, bad origin 403, bad body 400, unknown session 204", async () => {
      const h = await make();
      const { deps } = makeDeps(h, { t: T0 });
      const ok = await end(deps, sid(50));
      assert.equal(ok.status, 204);
      assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
      assert.equal((await end(deps, sid(50), { origin: "https://evil.example" })).status, 403);
      assert.equal((await end(deps, sid(50), { body: "not json" })).status, 400);
      assert.equal((await end(deps, sid(50), { body: JSON.stringify({ sessionId: "nope" }) })).status, 400);
      assert.equal((await end(deps, sid(50), { origin: null })).status, 204);
      const pre = await handleChatEnd(new Request(`${ORIGIN}/api/chat/end`, { method: "OPTIONS", headers: { origin: ORIGIN } }), deps);
      assert.equal(pre.status, 204);
      await h.close();
    });

    it("Kiara #7: messages carry their chat id; transcripts never mix chats; latestChat is the newest chat (deterministic time)", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps } = makeDeps(h, clock);
      await quiet(async () => {
        await say(deps, sid(51), "hi");
        await end(deps, sid(51));
        await say(deps, sid(51), "price of blue diamond?");
      });
      const rows = await h.chats();
      assert.equal(rows.length, 2);
      assert.ok(rows[0]!.startedAt < rows[1]!.startedAt, "distinct, ordered start times");
      assert.equal((await h.store.chatTranscript(rows[0]!.id)).length, 2);
      assert.equal((await h.store.chatTranscript(rows[1]!.id))[0]!.text, "price of blue diamond?");
      assert.equal((await h.store.latestChat(sid(51)))!.id, rows[1]!.id);
      await h.close();
    });

    it("latestChat breaks a same-millisecond tie by insertion order (never by uuid)", async () => {
      const h = await make();
      const ids = ["ffffffff-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
      for (const id of ids) await h.store.startChat({ id, sessionId: sid(52), source: "site", ipHash: null, nowMs: T0 });
      assert.equal((await h.store.latestChat(sid(52)))!.id, ids[1]);
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
    CLOCKS.set(deps, clock);
    await quiet(async () => {
      await say(deps, sid(60), "I live in Kochi");
      await say(deps, sid(60), "I'm Ravi, 98450 12345");
      clock.t += 11 * MIN;
      await say(deps, sid(61), "hi"); // another visitor's request sweeps chat 1 (closed, then 10 quiet min)
      clock.t += 4 * 24 * 60 * MIN;
      await say(deps, sid(60), "Ravi again 98450 12345");
      await end(deps, sid(60));
    });
    // Ravi's two chats (Lead, then Lead · returning) + the sweeping visitor's own idle "hi" chat.
    assert.equal(calls.length, 3, "one per chat, returning customer included");
    const subjects = calls.map((c) => (JSON.parse(String(c.init.body)) as { subject: string }).subject);
    assert.equal(subjects.filter((x) => x.startsWith("[Lead")).length, 2);
    const keys = calls.map((c) => (c.init.headers as Record<string, string>)["Idempotency-Key"]);
    assert.equal(new Set(keys).size, 3, "per-chat key: Resend must not dedupe the returning visitor's email");
    assert.match(keys[0]!, /^tdd-chat-[0-9a-f-]{36}$/);
    const body = JSON.parse(String(calls[0]!.init.body)) as { subject: string; text: string };
    assert.match(body.subject, /^\[Lead\] New chat lead: Ravi/);
    for (const re of [
      /Tag: {9}Lead/,
      /Name: {8}Ravi/,
      /Phone: {7}\+919845012345/,
      /City: {8}Kochi/, // LB-22: the volunteered city ("I live in Kochi") is kept (was its state, Kerala)
      /Source: {6}\?from=insta/,
      /Chat started: 08 Oct 2026, 11:30 IST/,
      /Chat ended: {3}08 Oct 2026, 11:41 IST \(closing message after details were collected, then 10 min with no messages\)/,
      /Visitor: I live in Kochi/,
      /Visitor: I'm Ravi, 98450 12345/,
    ]) {
      assert.match(body.text, re);
    }
  });
});

// ---------------------------------------------------------------------------
// LB-22 (Shiva, 8 Oct 2:13 PM) — Kiara's lb22-test-cases.md, email side (G4), on both stores.
// ---------------------------------------------------------------------------
const LB22_SHIVA = [
  "Hey - how is it going. I am Arjun from Bangalore looking to buy discus.",
  "Sounds good - how to order and pay online!",
  "I see - thanks. Can you connect to the owner or a human agent?",
];
const LB22_CLAIM = /\b(I've|I have)\s+(already\s+)?(passed|shared|sent)\b|\bpassed your (details|number)\b/i;
for (const [label, make] of [["memory store", memoryHarness], ["Postgres store (PGlite + migrations)", pgHarness]] as const) {
  describe(`LB-22 · human requests and the one email per chat · ${label}`, () => {
    it("case 1: Shiva's chat + a valid number -> closing by name; End -> exactly 1 [Lead] email (Arjun, number, Bangalore, full transcript)", async () => {
      const h = await make();
      const { deps, sent } = makeDeps(h, { t: T0 });
      const replies: string[] = [];
      await quiet(async () => {
        for (const m of LB22_SHIVA) replies.push(await say(deps, sid(221), m));
        replies.push(await say(deps, sid(221), "My WhatsApp number is 9845012312"));
        await end(deps, sid(221));
      });
      assert.ok(replies[0]!.endsWith(ANSWERS.humanAskPhone("Arjun", 0)));
      assert.equal(replies[2], ANSWERS.humanAskPhone("Arjun", 1));
      assert.doesNotMatch(replies[2]!, LB22_CLAIM);
      assert.equal(replies[3], ANSWERS.handoffClose("Arjun"));
      assert.equal(sent.length, 1);
      const email = buildLeadAlertEmail(sent[0]!.lead, sent[0]!.transcript, { to: "x@example.com" });
      assert.match(email.subject, /^\[Lead\] New chat lead: Arjun/);
      assert.match(email.text, /Phone: {7}\+919845012312/);
      assert.match(email.text, /City: {8}Bangalore/);
      assert.equal(sent[0]!.transcript.length, 8);
      assert.equal((await h.chats())[0]!.phone, "+919845012312");
      await h.close();
    });
    it("case 1b: same chat, then 'No thanks' -> no claim; End -> 1 [Visitor] email (name Arjun, no number)", async () => {
      const h = await make();
      const { deps, sent } = makeDeps(h, { t: T0 });
      const replies: string[] = [];
      await quiet(async () => {
        for (const m of [...LB22_SHIVA, "No thanks"]) replies.push(await say(deps, sid(222), m));
        await end(deps, sid(222));
      });
      for (const r of replies) assert.doesNotMatch(r, LB22_CLAIM);
      assert.equal(replies[3], ANSWERS.handoffDeclined);
      assert.equal(sent.length, 1);
      assert.match(subjectOf(sent[0]!), /^\[Visitor[^\]]*\] Website chat: Arjun/);
      await h.close();
    });
    it("case 3b: an invalid number after the ask -> recheck, never saved; End -> [Visitor]", async () => {
      const h = await make();
      const { deps, sent } = makeDeps(h, { t: T0 });
      const replies: string[] = [];
      await quiet(async () => {
        replies.push(await say(deps, sid(223), "Connect me to the owner"));
        replies.push(await say(deps, sid(223), "+91 98765 000"));
        await end(deps, sid(223));
      });
      assert.equal(replies[1], ANSWERS.phoneInvalid);
      for (const r of replies) assert.doesNotMatch(r, LB22_CLAIM);
      assert.match(subjectOf(sent[0]!), /^\[Visitor/);
      assert.equal((await h.chats())[0]!.phone, null);
      await h.close();
    });
    it("case 4: number first, then 'Can I talk to Shiva?' -> masked confirmation (no re-ask); End -> 1 [Lead] email", async () => {
      const h = await make();
      const { deps, sent } = makeDeps(h, { t: T0 });
      const replies: string[] = [];
      await quiet(async () => {
        replies.push(await say(deps, sid(224), "I am Priya, my number is 9123456780"));
        replies.push(await say(deps, sid(224), "Can I talk to Shiva?"));
        await end(deps, sid(224));
      });
      assert.equal(replies[1], ANSWERS.humanConfirm("Priya", "91xxxxxx80", 0));
      assert.equal(sent.length, 1);
      assert.match(subjectOf(sent[0]!), /^\[Lead\] New chat lead: Priya/);
      await h.close();
    });
    it("case 6: known returning customer -> 'Can I talk to the owner?' confirms the number on file; 'yes' -> true claim; End -> [Lead · returning]", async () => {
      const h = await make();
      const clock = { t: T0 };
      const { deps, sent } = makeDeps(h, clock);
      const replies: string[] = [];
      await quiet(async () => {
        await say(deps, sid(225), "What is the price of Blue Diamond?");
        await say(deps, sid(225), "I'm Ravi, 9845012345");
        await end(deps, sid(225));
        clock.t += 24 * 60 * MIN; // day 2, same browser session
        replies.push(await say(deps, sid(225), "Can I talk to the owner?"));
        replies.push(await say(deps, sid(225), "yes"));
        await end(deps, sid(225));
      });
      assert.equal(replies[0], ANSWERS.humanConfirm("Ravi", "98xxxxxx45", 0));
      assert.equal(replies[1], ANSWERS.humanConfirmYes("Ravi", 0));
      assert.equal(sent.length, 2);
      assert.match(subjectOf(sent[1]!), /^\[Lead · returning\] Website chat: Ravi/);
      await h.close();
    });
  });
}
