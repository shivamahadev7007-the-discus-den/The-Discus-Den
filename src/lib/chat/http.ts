/**
 * HTTP layer for POST /api/chat (framework-free: Request in, Response out).
 *
 * Contract (front end already wired):
 *   POST { sessionId: uuid, message: string (1..1000), source: insta|fb|yt|site }
 *   -> 200 { reply: string, handoff: boolean }
 * Errors also carry a friendly { reply, handoff: false } body.
 */

import { createHash, randomUUID } from "node:crypto";
import { ANSWERS } from "./answers.ts";
import type { CatalogLoader } from "./catalog.ts";
import { isCourtesyOnly, newChatFrom, respond, type ChatState } from "./engine.ts";
import { guardReply } from "./guard.ts";
import { chatTag, sendChatDigest, sendLeadAlert, type DigestItem, type LeadAlertResult, type LeadForAlert, type TranscriptLine } from "./lead-alert.ts";
import { type ChatEmailStatus, type ChatRow, type ChatStore } from "./store.ts";

export const DEFAULT_ORIGINS = ["https://thediscusden.com", "https://www.thediscusden.com"];
export const SOURCES = ["insta", "fb", "yt", "site"] as const;
export type ChatSource = (typeof SOURCES)[number];

export const MAX_MESSAGE_CHARS = 1000;
const MAX_BODY_BYTES = 16 * 1024;
export const RATE_LIMITS = {
  session: { limit: 20, windowSeconds: 5 * 60 },
  ip: { limit: 60, windowSeconds: 10 * 60 },
};
/**
 * Chat-email flood control defaults (override with env). LB-19: a capped chat is
 * never lost: it is marked 'capped' and listed in the daily digest.
 *   ipPer24h       Visitor emails per IP hash per 24 h (Leads with a valid mobile skip this cap)
 *   globalPerHour  instant emails per hour overall (anti-abuse)
 */
export const ALERT_CAPS = { ipPer24h: 3, globalPerHour: 20 };
/** LB-19: a chat with no messages for this long has ended. */
export const CHAT_IDLE_MS = 10 * 60_000;
/** LB-19: opportunistic idle sweep on each /api/chat request: small batch, short budget. */
export const SWEEP = { batch: 3, budgetMs: 2_500 };
/** LB-19: daily digest size (the rest follow next day). */
export const DIGEST_LIMIT = 40;

function envInt(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Front end gives up at 15 s; answer well before that. */
const TIME_BUDGET_MS = 11_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Env = Record<string, string | undefined>;

export type ChatDeps = {
  store: ChatStore;
  catalog: CatalogLoader;
  env?: Env;
  now?: () => number;
  sendAlert?: (lead: LeadForAlert, transcript: TranscriptLine[]) => Promise<LeadAlertResult>;
  /** LB-19: daily digest sender (default: sendChatDigest via Resend). */
  sendDigest?: (items: DigestItem[], more: number) => Promise<LeadAlertResult>;
  /** LB-19: chat id generator (tests). */
  newId?: () => string;
  /**
   * LB-7: the visitor's own lead email is always awaited, never handed to waitUntil.
   * LB-19: only an idle-sweep batch that outlives its short budget is handed here as
   * a best effort; correctness never depends on it (stale claims are retried).
   */
  waitUntil?: (p: Promise<unknown>) => void;
};

/**
 * Vercel's Node runtime exposes waitUntil on a global request context (this is
 * what @vercel/functions reads). Returns undefined anywhere else.
 */
export function platformWaitUntil(): ((p: Promise<unknown>) => void) | undefined {
  try {
    const ctx = (globalThis as Record<symbol, unknown>)[Symbol.for("@vercel/request-context")] as
      | { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined }
      | undefined;
    const wu = ctx?.get?.()?.waitUntil;
    return typeof wu === "function" ? wu : undefined;
  } catch {
    return undefined;
  }
}

function normOrigin(o: string): string {
  return o.trim().replace(/\/+$/, "").toLowerCase();
}

export function allowedOrigins(env: Env = {}): string[] {
  const extra = (env.CHAT_EXTRA_ORIGINS ?? "")
    .split(",")
    .map(normOrigin)
    .filter((o) => /^https?:\/\/[^\s/]+$/.test(o));
  return [...new Set([...DEFAULT_ORIGINS, ...extra])];
}

export function corsHeaders(origin: string | null, env: Env = {}): Record<string, string> | null {
  if (!origin) return {};
  if (!allowedOrigins(env).includes(normOrigin(origin))) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(status: number, body: { reply: string; handoff: boolean }, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export function normaliseSource(v: unknown): ChatSource {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (SOURCES as readonly string[]).includes(s) ? (s as ChatSource) : "site";
}

export function clientIp(request: Request): string | null {
  const h = request.headers;
  const fwd = h.get("x-vercel-forwarded-for") ?? h.get("x-forwarded-for") ?? h.get("x-real-ip");
  const ip = fwd?.split(",")[0]?.trim();
  return ip || null;
}

export function hashIp(ip: string | null, env: Env = {}): string | null {
  if (!ip) return null;
  const salt = env.CHAT_IP_SALT || "tdd-chat-default-salt";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

export function handleOptions(request: Request, env: Env = {}): Response {
  const cors = corsHeaders(request.headers.get("origin"), env);
  if (cors === null) return new Response(null, { status: 403, headers: { Vary: "Origin" } });
  return new Response(null, { status: 204, headers: cors });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("chat time budget exceeded")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function handleChatRequest(request: Request, deps: ChatDeps): Promise<Response> {
  const env = deps.env ?? {};
  const now = deps.now ?? Date.now;
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") return handleOptions(request, env);

  const cors = corsHeaders(request.headers.get("origin"), env);
  if (cors === null) {
    return json(403, { reply: ANSWERS.badSession, handoff: false }, { Vary: "Origin" });
  }
  if (method !== "POST") {
    return json(405, { reply: ANSWERS.badSession, handoff: false }, { ...cors, Allow: "POST, OPTIONS" });
  }

  // --- Parse + validate ---
  let body: { sessionId?: unknown; message?: unknown; source?: unknown };
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return json(413, { reply: ANSWERS.tooLong, handoff: false }, cors);
    }
    body = JSON.parse(text);
    if (!body || typeof body !== "object") throw new Error("not an object");
  } catch {
    return json(400, { reply: ANSWERS.badSession, handoff: false }, cors);
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (!UUID_RE.test(sessionId)) {
    return json(400, { reply: ANSWERS.badSession, handoff: false }, cors);
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return json(400, { reply: ANSWERS.emptyMessage, handoff: false }, cors);
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return json(400, { reply: ANSWERS.tooLong, handoff: false }, cors);
  }
  const source = normaliseSource(body.source);
  const ipHash = hashIp(clientIp(request), env);
  const sid = sessionId.toLowerCase();

  try {
    return await withTimeout(
      (async () => {
        // --- Rate limits (DB-backed; serverless has no shared memory) ---
        const nowMs = now();
        const [sessionHits, ipHits] = await Promise.all([
          deps.store.hitRateLimit(`s:${sid}`, RATE_LIMITS.session.windowSeconds, nowMs),
          ipHash ? deps.store.hitRateLimit(`ip:${ipHash}`, RATE_LIMITS.ip.windowSeconds, nowMs) : Promise.resolve(0),
        ]);
        if (sessionHits > RATE_LIMITS.session.limit || ipHits > RATE_LIMITS.ip.limit) {
          const retry = sessionHits > RATE_LIMITS.session.limit ? RATE_LIMITS.session.windowSeconds : RATE_LIMITS.ip.windowSeconds;
          return json(429, { reply: ANSWERS.rateLimited, handoff: false }, { ...cors, "Retry-After": String(retry) });
        }

        // --- LB-19: idle sweep of OTHER sessions' chats, in parallel, bounded ---
        const sweepStarted = Date.now();
        const background: Array<Promise<unknown>> = [sweepIdleChats(deps, env, nowMs, sid)];

        // --- LB-19: which chat does this message belong to? ---
        const prevSession = await deps.store.loadSession(sid);
        const idleMs = envInt(env, "CHAT_IDLE_MINUTES", CHAT_IDLE_MS / 60_000) * 60_000 || CHAT_IDLE_MS;
        let chat = await deps.store.latestChat(sid);
        if (chat && chat.endedAt === null && nowMs - chat.lastMessageAt >= idleMs) {
          // This visitor's previous chat went idle: end it and email it (alongside the sweep).
          if (await deps.store.endChat(chat.id, "idle", nowMs)) {
            const endedId = chat.id;
            background.push(emailChat(deps, env, endedId, nowMs, { retryFailed: true, trigger: "idle" }));
          }
          chat = { ...chat, endedAt: nowMs, endReason: "idle" };
        }
        let engineState: ChatState | null = prevSession;
        if (!chat || chat.endedAt !== null) {
          // "thanks" / "bye" just after the closing message stays in that chat (no new email).
          const courtesy = Boolean(chat && chat.endReason === "closing" && nowMs - (chat.endedAt ?? 0) < idleMs && isCourtesyOnly(message));
          if (!courtesy) {
            // New chat (first visit, or the last one ended / was emailed): fresh per-chat
            // state, earlier details carried as `prior`.
            engineState = newChatFrom(prevSession);
            chat = await deps.store.startChat({ id: (deps.newId ?? randomUUID)(), sessionId: sid, source, ipHash, nowMs });
          }
        }
        const chatId = chat!.id;

        // --- Bot brain ---
        const result = await respond(engineState, message, { catalog: deps.catalog });
        const guarded = guardReply(result.reply);
        if (guarded.blocked.length || guarded.stripped) {
          console.warn(`[chat] output guard: blocked=${guarded.blocked.join(",") || "-"} stripped=${guarded.stripped} intent=${result.intent}`);
        }
        const reply = guarded.text;
        // LB-6 D2: the guard's safe reply is a site steer, not an offer.
        if (guarded.blocked.length && reply === ANSWERS.unsure) result.state.pendingOffer = null;

        // --- Persist (never echoed back) ---
        await Promise.all([
          deps.store.saveSession(sid, source, ipHash, result.state),
          deps.store.appendMessages([
            { sessionId: sid, chatId, role: "user", text: message, source, ipHash, intent: result.intent },
            { sessionId: sid, chatId, role: "bot", text: reply, source, ipHash, intent: result.intent },
          ]),
          deps.store.upsertLead(sid, source, result.state),
          deps.store.touchChat({ chatId, state: result.state, ipHash, nowMs }),
        ]);

        // --- LB-19: one email per chat, always at chat END, with the full transcript ---
        // (Shiva, 8 Oct 11:37: no instant email when a number is typed.) The bot's closing
        // message after details are collected ends the chat here; /api/chat/end and the
        // 10-min idle sweep end the others. LB-7: the send is ALWAYS awaited.
        if (result.closedNow) {
          await deps.store.endChat(chatId, "closing", nowMs);
          await emailChat(deps, env, chatId, nowMs, { retryFailed: true, trigger: "closing" });
        }

        // The sweep never blocks the reply for long: wait out what's left of its budget.
        const all = Promise.allSettled(background);
        const left = SWEEP.budgetMs - (Date.now() - sweepStarted);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finished = await Promise.race([
          all.then(() => true),
          new Promise<boolean>((r) => {
            timer = setTimeout(() => r(false), Math.max(0, left));
          }),
        ]);
        clearTimeout(timer);
        if (!finished) (deps.waitUntil ?? platformWaitUntil())?.(all);

        return json(200, { reply, handoff: result.handoff }, cors);
      })(),
      TIME_BUDGET_MS,
    );
  } catch (err) {
    console.error("[chat] request failed", err instanceof Error ? err.message : err);
    return json(503, { reply: ANSWERS.serverError, handoff: false }, cors);
  }
}

function chatMeta(c: ChatRow) {
  return { id: c.id, startedAt: c.startedAt, lastMessageAt: c.lastMessageAt, endedAt: c.endedAt, endReason: c.endReason };
}

function short(id: string): string {
  return id.slice(0, 8);
}

/**
 * LB-19: send THE email for one chat. Claim first (atomic; only one caller wins),
 * then caps, then Resend. Only a Resend OK marks the chat 'sent'. A failure /
 * mode off / cap releases it as failed / off / capped so the daily digest picks
 * it up. Every skip is logged: "[chat] lead alert skipped: <reason>". Never throws.
 */
export async function emailChat(
  deps: ChatDeps,
  env: Env,
  chatId: string,
  nowMs: number,
  opts: { retryFailed: boolean; trigger: string },
): Promise<ChatEmailStatus | "skipped"> {
  let claimed: ChatRow | null = null;
  try {
    claimed = await deps.store.claimChatEmail({ chatId, nowMs, retryFailed: opts.retryFailed });
    if (!claimed) {
      const cur = await deps.store.getChat(chatId).catch(() => null);
      console.log(`[chat] lead alert skipped: claim-miss (${cur ? `chat already ${cur.emailStatus}` : "no such chat"}) chat=${short(chatId)} trigger=${opts.trigger}`);
      return "skipped";
    }
    const state = claimed.state;
    const kind = state && chatTag(state).tag === "Lead" ? "lead" : "visitor";
    const base = { chatId, sessionId: claimed.sessionId, kind, phone: state?.lead.phone ?? null, ipHash: claimed.ipHash, nowMs } as const;
    if (!state) {
      await deps.store.finishChatEmail({ ...base, status: "failed", via: "instant", note: "empty chat" });
      console.warn(`[chat] lead alert skipped: empty chat (no saved state) chat=${short(chatId)} (kept for the daily digest)`);
      return "failed";
    }
    const cap = await deps.store.chatEmailCaps({
      chatId,
      kind,
      ipHash: claimed.ipHash,
      ipCap: envInt(env, "CHAT_ALERT_IP_CAP_24H", ALERT_CAPS.ipPer24h),
      globalCap: envInt(env, "CHAT_ALERT_GLOBAL_CAP_HOUR", ALERT_CAPS.globalPerHour),
      nowMs,
    });
    if (cap !== "ok") {
      await deps.store.finishChatEmail({ ...base, status: "capped", via: "instant", note: cap });
      console.warn(`[chat] lead alert skipped: ${cap} chat=${short(chatId)} kind=${kind} (kept for the daily digest)`);
      return "capped";
    }
    const transcript = await deps.store.chatTranscript(chatId);
    const send = deps.sendAlert ?? ((l, t) => sendLeadAlert(l, t, env));
    const out = await send({ sessionId: claimed.sessionId, source: claimed.source, state, chat: chatMeta(claimed) }, transcript);
    if (out && out.sent) {
      await deps.store.finishChatEmail({ ...base, status: "sent", via: "instant", note: null });
      return "sent";
    }
    const status = out?.channel === "off" ? "off" : "failed";
    await deps.store.finishChatEmail({ ...base, status, via: "instant", note: out?.error ?? null });
    console.warn(`[chat] lead alert skipped: ${status === "off" ? "CHAT_LEAD_ALERT_MODE off" : `send failed (${out?.error ?? "unknown"})`} chat=${short(chatId)} kind=${kind} (kept for the daily digest)`);
    return status;
  } catch (err) {
    console.warn(`[chat] lead alert skipped: error (${err instanceof Error ? err.message : String(err)}) chat=${short(chatId)} (kept for the daily digest)`);
    if (claimed) {
      await deps.store
        .finishChatEmail({ chatId, sessionId: claimed.sessionId, kind: claimed.state && chatTag(claimed.state).tag === "Lead" ? "lead" : "visitor", phone: claimed.state?.lead.phone ?? null, ipHash: claimed.ipHash, nowMs, status: "failed", via: "instant", note: "error" })
        .catch(() => undefined);
    }
    return "failed";
  }
}

/** LB-19: end a few idle chats of other sessions and email them. Never throws. */
export async function sweepIdleChats(deps: ChatDeps, env: Env, nowMs: number, excludeSessionId: string | null): Promise<number> {
  try {
    const idleMs = envInt(env, "CHAT_IDLE_MINUTES", CHAT_IDLE_MS / 60_000) * 60_000 || CHAT_IDLE_MS;
    const ids = await deps.store.endIdleChats({ cutoffMs: nowMs - idleMs, nowMs, limit: SWEEP.batch, excludeSessionId });
    for (const id of ids) await emailChat(deps, env, id, nowMs, { retryFailed: true, trigger: "idle-sweep" });
    return ids.length;
  } catch (err) {
    console.warn("[chat] idle sweep failed (soft)", err instanceof Error ? err.message : err);
    return 0;
  }
}

function noContent(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", ...headers } });
}

/**
 * LB-19: POST /api/chat/end { sessionId } — the widget calls it with
 * navigator.sendBeacon on close / pagehide (text/plain or application/json body).
 * Ends the session's open chat and sends its email if none went yet. Idempotent:
 * a second call finds the chat ended/emailed and does nothing. Always 204 on a
 * valid body (sendBeacon ignores the response anyway).
 */
export async function handleChatEnd(request: Request, deps: ChatDeps): Promise<Response> {
  const env = deps.env ?? {};
  const now = deps.now ?? Date.now;
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return handleOptions(request, env);
  const cors = corsHeaders(request.headers.get("origin"), env);
  if (cors === null) return new Response(null, { status: 403, headers: { Vary: "Origin" } });
  if (method !== "POST") return new Response(null, { status: 405, headers: { ...cors, Allow: "POST, OPTIONS" } });

  let sessionId = "";
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return new Response(null, { status: 413, headers: cors });
    const body = JSON.parse(text) as { sessionId?: unknown };
    sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
  } catch {
    sessionId = "";
  }
  if (!UUID_RE.test(sessionId)) return new Response(null, { status: 400, headers: cors });
  const sid = sessionId.toLowerCase();

  try {
    return await withTimeout(
      (async () => {
        const nowMs = now();
        const ipHash = hashIp(clientIp(request), env);
        if (ipHash && (await deps.store.hitRateLimit(`end:${ipHash}`, RATE_LIMITS.ip.windowSeconds, nowMs)) > RATE_LIMITS.ip.limit) {
          return new Response(null, { status: 429, headers: { ...cors, "Retry-After": String(RATE_LIMITS.ip.windowSeconds) } });
        }
        const chat = await deps.store.latestChat(sid);
        if (!chat) return noContent(cors);
        if (chat.endedAt === null) await deps.store.endChat(chat.id, "beacon", nowMs);
        // pending / failed / a claim that may be stale (the store decides): try to send.
        if (chat.emailStatus === "pending" || chat.emailStatus === "failed" || chat.emailStatus === "claimed") {
          await emailChat(deps, env, chat.id, nowMs, { retryFailed: true, trigger: "end" });
        }
        return noContent(cors);
      })(),
      TIME_BUDGET_MS,
    );
  } catch (err) {
    console.error("[chat] /end failed", err instanceof Error ? err.message : err);
    return new Response(null, { status: 503, headers: cors });
  }
}

/**
 * LB-19: daily cron (Vercel Hobby: once a day). Ends every idle chat, then sends
 * ONE digest email listing ended chats that never got their email (failed sends,
 * capped, mode off, or ended with no traffic to sweep them), and marks them.
 * If the digest send fails, they stay queued for tomorrow. Protected by
 * CRON_SECRET (Vercel sends "Authorization: Bearer <CRON_SECRET>") when set.
 */
export async function handleChatCron(request: Request, deps: ChatDeps): Promise<Response> {
  const env = deps.env ?? {};
  const now = deps.now ?? Date.now;
  const secret = env.CRON_SECRET?.trim();
  const reply = (status: number, body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  if (secret) {
    if (request.headers.get("authorization") !== `Bearer ${secret}`) return reply(401, { ok: false });
  } else {
    console.warn("[chat] cron: CRON_SECRET is not set; running without auth (digest only ever emails Shiva)");
  }
  const nowMs = now();
  try {
    const idleMs = envInt(env, "CHAT_IDLE_MINUTES", CHAT_IDLE_MS / 60_000) * 60_000 || CHAT_IDLE_MS;
    let ended = 0;
    for (let i = 0; i < 20; i += 1) {
      const ids = await deps.store.endIdleChats({ cutoffMs: nowMs - idleMs, nowMs, limit: 100, excludeSessionId: null });
      ended += ids.length;
      if (ids.length < 100) break;
    }
    const candidates = await deps.store.digestCandidates({ nowMs, limit: DIGEST_LIMIT + 1, settleMs: 60_000 });
    const more = Math.max(0, candidates.length - DIGEST_LIMIT);
    const claimed: Array<{ row: ChatRow; was: ChatRow }> = [];
    for (const was of candidates.slice(0, DIGEST_LIMIT)) {
      const row = await deps.store.claimChatEmail({ chatId: was.id, nowMs, retryFailed: true, digest: true });
      if (row) claimed.push({ row, was });
      else console.log(`[chat] lead alert skipped: claim-miss (digest) chat=${short(was.id)}`);
    }
    if (!claimed.length) return reply(200, { ok: true, ended, digested: 0 });

    const items: DigestItem[] = [];
    for (const { row, was } of claimed) {
      items.push({
        lead: { sessionId: row.sessionId, source: row.source, state: row.state ?? emptyState(), chat: chatMeta(row) },
        transcript: await deps.store.chatTranscript(row.id),
        status: was.emailStatus,
        note: was.emailNote,
      });
    }
    const send = deps.sendDigest ?? ((it, m) => sendChatDigest(it, env, undefined, m));
    let out: LeadAlertResult;
    try {
      out = await send(items, more);
    } catch (err) {
      out = { sent: false, channel: "email", error: err instanceof Error ? err.message : String(err) };
    }
    for (const { row, was } of claimed) {
      const kind = row.state && chatTag(row.state).tag === "Lead" ? "lead" : "visitor";
      const status: ChatEmailStatus = out.sent ? "sent" : out.channel === "off" ? "off" : was.emailStatus === "capped" ? "capped" : "failed";
      await deps.store.finishChatEmail({
        chatId: row.id,
        sessionId: row.sessionId,
        kind,
        phone: row.state?.lead.phone ?? null,
        ipHash: row.ipHash,
        nowMs,
        status: status as Exclude<ChatEmailStatus, "pending" | "claimed">,
        via: "digest",
        note: out.sent ? "digest" : out.error ?? was.emailNote,
      });
    }
    if (out.sent) console.log(`[chat] chat digest: ${claimed.length} chat(s) emailed${more ? `, ${more}+ left for tomorrow` : ""}`);
    else console.warn(`[chat] lead alert skipped: digest not sent (${out.channel === "off" ? "CHAT_LEAD_ALERT_MODE off" : out.error ?? "failed"}); ${claimed.length} chat(s) stay queued`);
    return reply(200, { ok: true, ended, digested: out.sent ? claimed.length : 0, queued: out.sent ? more : claimed.length + more });
  } catch (err) {
    console.error("[chat] cron failed", err instanceof Error ? err.message : err);
    return reply(500, { ok: false });
  }
}

function emptyState(): ChatState {
  return newChatFrom(null);
}
