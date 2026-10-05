/**
 * HTTP layer for POST /api/chat (framework-free: Request in, Response out).
 *
 * Contract (front end already wired):
 *   POST { sessionId: uuid, message: string (1..1000), source: insta|fb|yt|site }
 *   -> 200 { reply: string, handoff: boolean }
 * Errors also carry a friendly { reply, handoff: false } body.
 */

import { createHash } from "node:crypto";
import { ANSWERS } from "./answers.ts";
import type { CatalogLoader } from "./catalog.ts";
import { respond } from "./engine.ts";
import { guardReply } from "./guard.ts";
import { sendLeadAlert, type LeadAlertResult, type LeadForAlert, type TranscriptLine } from "./lead-alert.ts";
import type { ChatStore } from "./store.ts";

export const DEFAULT_ORIGINS = ["https://thediscusden.com", "https://www.thediscusden.com"];
export const SOURCES = ["insta", "fb", "yt", "site"] as const;
export type ChatSource = (typeof SOURCES)[number];

export const MAX_MESSAGE_CHARS = 1000;
const MAX_BODY_BYTES = 16 * 1024;
export const RATE_LIMITS = {
  session: { limit: 20, windowSeconds: 5 * 60 },
  ip: { limit: 60, windowSeconds: 10 * 60 },
};
/** Lead-alert flood control defaults (override with env). */
export const ALERT_CAPS = { ipPer24h: 2, globalPerHour: 20 };

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
  /** @deprecated LB-7 5 Oct: lead alerts are always awaited; kept for test API compat, ignored. */
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

        // --- Bot brain ---
        const prev = await deps.store.loadSession(sid);
        const result = await respond(prev, message, { catalog: deps.catalog });
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
            { sessionId: sid, role: "user", text: message, source, ipHash, intent: result.intent },
            { sessionId: sid, role: "bot", text: reply, source, ipHash, intent: result.intent },
          ]),
          deps.store.upsertLead(sid, source, result.state),
        ]);

        // --- Lead alert: once per session, then flood control ---
        // LB-7: fire as soon as the lead is actionable (name + valid number captured), not
        // only after the last handoff question; visitors often stop replying after the number.
        const hasContact = (s: { lead?: { name?: string; phone?: string } } | null | undefined) =>
          Boolean(s?.lead?.name && s?.lead?.phone);
        const contactReadyNow = hasContact(result.state) && !hasContact(prev);
        if ((result.completedNow || contactReadyNow) && (await deps.store.claimLeadAlert(sid))) {
          const status = await deps.store.decideLeadAlert({
            sessionId: sid,
            phone: result.state.lead.phone ?? null,
            ipHash,
            ipCap: envInt(env, "CHAT_ALERT_IP_CAP_24H", ALERT_CAPS.ipPer24h),
            globalCap: envInt(env, "CHAT_ALERT_GLOBAL_CAP_HOUR", ALERT_CAPS.globalPerHour),
            nowMs,
          });
          if (status !== "sent") {
            console.warn(`[chat] lead alert ${status} (lead stored in DB)`);
          } else {
            const send = deps.sendAlert ?? ((l, t) => sendLeadAlert(l, t, env));
            // LB-7 (5 Oct): ALWAYS await the send. waitUntil was fire-and-forget: Vercel can
            // freeze the isolate after the response, so Resend never ran and recordAlertOutcome
            // never rewrote the optimistic 'sent' row. Those phantom 'sent' rows then hit the
            // per-phone (1/24h) and per-IP (2/24h) caps and suppressed every later real lead
            // (Shiva got Juniper's one test email and nothing after). sendLeadAlert already
            // times out at 5 s, so awaiting keeps the chat reply honest without hanging.
            try {
              const transcript = await deps.store.transcript(sid);
              const out = await send({ sessionId: sid, source, state: result.state }, transcript);
              if (out && out.sent) {
                await deps.store.confirmLeadAlertSent({
                  sessionId: sid,
                  phone: result.state.lead.phone ?? null,
                  ipHash,
                  nowMs,
                });
              } else {
                // LB-7: only alerts that really went out count toward the caps.
                await deps.store.recordAlertOutcome(sid, out?.channel === "off" ? "not_sent_off" : "failed");
              }
            } catch (err) {
              console.warn("[chat] lead alert failed (soft)", err instanceof Error ? err.message : err);
              await deps.store.recordAlertOutcome(sid, "failed").catch(() => undefined);
            }
          }
        }

        return json(200, { reply, handoff: result.handoff }, cors);
      })(),
      TIME_BUDGET_MS,
    );
  } catch (err) {
    console.error("[chat] request failed", err instanceof Error ? err.message : err);
    return json(503, { reply: ANSWERS.serverError, handoff: false }, cors);
  }
}
