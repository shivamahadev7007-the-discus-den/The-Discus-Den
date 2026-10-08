/**
 * Persistence for the Chat Assistant. Two implementations of one interface:
 *  - createSqlChatStore(getSql): Postgres via the repo's shared client
 *    (src/lib/db.ts: Neon/pg in production, PGLite in preview). Schema:
 *    migrations/0006_chat_assistant.sql.
 *  - createMemoryChatStore(): for unit tests only.
 *
 * Nothing here is ever returned to the browser by /api/chat.
 */

import type { ChatState } from "./engine.ts";
import type { TranscriptLine } from "./lead-alert.ts";

/** Audit vocabulary in chat_alerts (migrations 0007/0008). */
export type AlertStatus = "sent" | "suppressed_duplicate" | "suppressed_ip_cap" | "suppressed_global_cap";
/** What happened when an alert did not go out (LB-7). */
export type AlertOutcome = "failed" | "not_sent_off";

/**
 * LB-19: one row per chat (conversation). A browser keeps its sessionId forever,
 * so one session can hold many chats; each chat sends exactly one email.
 *   pending -> claimed -> sent            (Resend accepted it)
 *                      -> failed | off    (claim released: chat end / the daily digest retry)
 *                      -> capped          (anti-abuse cap hit: kept for the daily digest)
 * A claim older than CLAIM_STALE_MS (isolate frozen mid-send) is claimable again.
 */
export type ChatEmailStatus = "pending" | "claimed" | "sent" | "failed" | "capped" | "off";
export type ChatEndReason = "beacon" | "idle" | "closing";
export type ChatEmailKind = "lead" | "visitor";
export type CapVerdict = "ok" | "ip_cap" | "global_cap";

export type ChatRow = {
  id: string;
  sessionId: string;
  source: string;
  ipHash: string | null;
  state: ChatState | null;
  name: string | null;
  phone: string | null;
  city: string | null;
  userMessages: number;
  startedAt: number;
  lastMessageAt: number;
  endedAt: number | null;
  endReason: ChatEndReason | null;
  /** LB-19 fix: when the bot's closing message went out (the chat stays open 10 more quiet minutes). */
  closedAt: number | null;
  emailStatus: ChatEmailStatus;
  emailKind: ChatEmailKind | null;
  emailVia: "instant" | "digest" | null;
  emailedAt: number | null;
  emailNote: string | null;
};

export const CLAIM_STALE_MS = 2 * 60_000;

export type ClaimInput = {
  chatId: string;
  nowMs: number;
  /** Also re-claim a chat whose earlier send failed (chat end, /end). */
  retryFailed: boolean;
  /** Daily digest: also claim capped / off chats (anything ended and never emailed). */
  digest?: boolean;
};
export type CapInput = {
  chatId: string;
  kind: ChatEmailKind;
  ipHash: string | null;
  ipCap: number;
  globalCap: number;
  nowMs: number;
};
export type FinishInput = {
  chatId: string;
  sessionId: string;
  status: Exclude<ChatEmailStatus, "pending" | "claimed">;
  kind: ChatEmailKind;
  via: "instant" | "digest";
  note?: string | null;
  phone: string | null;
  ipHash: string | null;
  nowMs: number;
};

/**
 * Caps rule shared by both stores (LB-19 fix, Kiara #3): a Lead is NEVER capped (neither
 * the global hourly cap nor the per-IP cap), and only Visitor emails are counted, so Leads
 * never use up the Visitor allowance either.
 */
export function capVerdict(counts: { byIp24h: number; global1h: number }, input: Pick<CapInput, "kind" | "ipHash" | "ipCap" | "globalCap">): CapVerdict {
  if (input.kind === "lead") return "ok";
  if (counts.global1h >= input.globalCap) return "global_cap";
  if (input.kind === "visitor" && input.ipHash && counts.byIp24h >= input.ipCap) return "ip_cap";
  return "ok";
}

function auditStatus(f: FinishInput): AlertStatus | AlertOutcome {
  if (f.status === "sent") return "sent";
  if (f.status === "off") return "not_sent_off";
  if (f.status === "capped") return f.note === "ip_cap" ? "suppressed_ip_cap" : "suppressed_global_cap";
  return "failed";
}

export type MessageRow = {
  sessionId: string;
  role: "user" | "bot";
  text: string;
  source: string;
  ipHash: string | null;
  intent?: string | null;
  /** LB-19: the chat (conversation) this message belongs to. */
  chatId?: string | null;
};

export interface ChatStore {
  /** Count one hit in a fixed window; returns the hit count after this one. */
  hitRateLimit(bucket: string, windowSeconds: number, nowMs: number): Promise<number>;
  loadSession(sessionId: string): Promise<ChatState | null>;
  saveSession(sessionId: string, source: string, ipHash: string | null, state: ChatState): Promise<void>;
  appendMessages(rows: MessageRow[]): Promise<void>;
  upsertLead(sessionId: string, source: string, state: ChatState): Promise<void>;
  // ---- LB-19: chats (conversations) and their one email ----
  /** The session's most recent chat (open or ended), or null. */
  latestChat(sessionId: string): Promise<ChatRow | null>;
  getChat(chatId: string): Promise<ChatRow | null>;
  startChat(input: { id: string; sessionId: string; source: string; ipHash: string | null; nowMs: number }): Promise<ChatRow>;
  /** After each turn: state snapshot, lead fields, last_message_at. */
  touchChat(input: { chatId: string; state: ChatState; ipHash: string | null; nowMs: number }): Promise<void>;
  /** Ends an open chat; true only for the call that ended it (idempotent). */
  endChat(chatId: string, reason: ChatEndReason, nowMs: number): Promise<boolean>;
  /** LB-19 fix: the closing message went out; the chat stays open (ends after 10 quiet min or on /end). */
  markChatClosed(chatId: string, nowMs: number): Promise<void>;
  /** Ends up to `limit` chats idle since before `cutoffMs` (other sessions only); returns their ids.
   *  end_reason = 'closing' if the closing message went out, else 'idle'. */
  endIdleChats(input: { cutoffMs: number; nowMs: number; limit: number; excludeSessionId?: string | null }): Promise<string[]>;
  /** Atomic: pending (or stale claim, or failed when retryFailed) -> claimed. Null = someone else has it / already emailed. */
  claimChatEmail(input: ClaimInput): Promise<ChatRow | null>;
  /** Anti-abuse caps, counted from Visitor chats really emailed instantly (Leads are never capped). */
  chatEmailCaps(input: CapInput): Promise<CapVerdict>;
  /** Final status for a claimed chat (+ an audit row in chat_alerts, + chat_leads.alert_status). */
  finishChatEmail(input: FinishInput): Promise<void>;
  /** Ended chats never emailed (failed / capped / off / stale claim, pending once settled or in includeIds), oldest first. */
  digestCandidates(input: { nowMs: number; limit: number; settleMs: number; includeIds?: string[] }): Promise<ChatRow[]>;
  /** Ended chats still waiting for their own email (pending ended before endedBeforeMs, or a stale claim). */
  pendingEndedChats(input: { nowMs: number; endedBeforeMs: number; limit: number }): Promise<string[]>;
  chatTranscript(chatId: string): Promise<TranscriptLine[]>;
  transcript(sessionId: string): Promise<TranscriptLine[]>;
}

/** Minimal surface of src/lib/db.ts's Sql that this store needs. */
export type SqlLike = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

export function windowStart(nowMs: number, windowSeconds: number): Date {
  const w = windowSeconds * 1000;
  return new Date(Math.floor(nowMs / w) * w);
}

function leadHasData(s: ChatState): boolean {
  const l = s.lead;
  return Boolean(s.handoff.active || s.completed || l.name || l.phone || l.city);
}

const CHAT_COLS =
  "id, session_id, source, ip_hash, state, name, phone, city, user_messages, started_at, last_message_at, ended_at, end_reason, closed_at, email_status, email_kind, email_via, emailed_at, email_note";

type DbChat = {
  id: string;
  session_id: string;
  source: string;
  ip_hash: string | null;
  state: unknown;
  name: string | null;
  phone: string | null;
  city: string | null;
  user_messages: number;
  started_at: string | Date;
  last_message_at: string | Date;
  ended_at: string | Date | null;
  end_reason: ChatEndReason | null;
  closed_at: string | Date | null;
  email_status: ChatEmailStatus;
  email_kind: ChatEmailKind | null;
  email_via: "instant" | "digest" | null;
  emailed_at: string | Date | null;
  email_note: string | null;
};

const ms = (v: string | Date | null): number | null => (v === null || v === undefined ? null : new Date(v).getTime());

function rowToChat(r: DbChat): ChatRow {
  const raw = typeof r.state === "string" ? JSON.parse(r.state) : r.state;
  const state = raw && typeof raw === "object" && (raw as ChatState).v === 1 ? (raw as ChatState) : null;
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    source: r.source,
    ipHash: r.ip_hash,
    state,
    name: r.name,
    phone: r.phone,
    city: r.city,
    userMessages: Number(r.user_messages ?? 0),
    startedAt: ms(r.started_at)!,
    lastMessageAt: ms(r.last_message_at)!,
    endedAt: ms(r.ended_at),
    endReason: r.end_reason,
    closedAt: ms(r.closed_at),
    emailStatus: r.email_status,
    emailKind: r.email_kind,
    emailVia: r.email_via,
    emailedAt: ms(r.emailed_at),
    emailNote: r.email_note,
  };
}

export function createSqlChatStore(getSql: () => Promise<SqlLike>): ChatStore {
  return {
    async hitRateLimit(bucket, windowSeconds, nowMs) {
      const sql = await getSql();
      const rows = await sql.query<{ hits: number }>(
        `insert into chat_rate_limits (bucket, window_start, hits) values ($1, $2, 1)
         on conflict (bucket, window_start) do update set hits = chat_rate_limits.hits + 1
         returning hits`,
        [bucket, windowStart(nowMs, windowSeconds).toISOString()],
      );
      // Light housekeeping: ~1% of hits prune windows older than a day.
      if (Math.random() < 0.01) {
        void sql
          .query("delete from chat_rate_limits where window_start < now() - interval '1 day'")
          .catch(() => undefined);
      }
      return Number(rows[0]?.hits ?? 1);
    },

    async loadSession(sessionId) {
      const sql = await getSql();
      const rows = await sql.query<{ state: unknown }>("select state from chat_sessions where id = $1", [sessionId]);
      const raw = rows[0]?.state;
      if (!raw) return null;
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return parsed && typeof parsed === "object" && (parsed as ChatState).v === 1 ? (parsed as ChatState) : null;
    },

    async saveSession(sessionId, source, ipHash, state) {
      const sql = await getSql();
      await sql.query(
        `insert into chat_sessions (id, source, ip_hash, state) values ($1, $2, $3, $4::jsonb)
         on conflict (id) do update set state = excluded.state, ip_hash = coalesce(excluded.ip_hash, chat_sessions.ip_hash), updated_at = now()`,
        [sessionId, source, ipHash, JSON.stringify(state)],
      );
    },

    async appendMessages(rows) {
      if (!rows.length) return;
      const sql = await getSql();
      const params: unknown[] = [];
      const values = rows.map((r, i) => {
        params.push(r.sessionId, r.role, r.text, r.source, r.ipHash, r.intent ?? null, r.chatId ?? null);
        const b = i * 7;
        // clock_timestamp() keeps user-before-bot ordering visible in created_at too.
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, clock_timestamp())`;
      });
      await sql.query(
        `insert into chat_messages (session_id, role, text, source, ip_hash, intent, chat_id, created_at) values ${values.join(", ")}`,
        params,
      );
    },

    async upsertLead(sessionId, source, state) {
      if (!leadHasData(state)) return;
      const sql = await getSql();
      const l = state.lead;
      const tags = [state.tags.buyer, state.tags.history, state.tags.heat].filter(Boolean);
      await sql.query(
        `insert into chat_leads (session_id, source, name, phone, city, state_name, in_ship_states, pair_single, delivery, timeline, tags, flags, interest, completed, completed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, case when $14 then now() else null end)
         on conflict (session_id) do update set
           name = coalesce(excluded.name, chat_leads.name), phone = coalesce(excluded.phone, chat_leads.phone),
           city = coalesce(excluded.city, chat_leads.city), state_name = coalesce(excluded.state_name, chat_leads.state_name),
           in_ship_states = excluded.in_ship_states, pair_single = excluded.pair_single, delivery = excluded.delivery,
           timeline = excluded.timeline, tags = excluded.tags, flags = excluded.flags, interest = excluded.interest,
           completed = chat_leads.completed or excluded.completed,
           completed_at = coalesce(chat_leads.completed_at, excluded.completed_at),
           updated_at = now()`,
        [
          sessionId,
          source,
          l.name ?? null,
          l.phone ?? null,
          l.city ?? null,
          l.stateName ?? null,
          l.inShipStates ?? null,
          l.lookingFor ?? null, // LB-11: pair_single column repurposed for fish-or-food (old rows keep pair/single; no migration)
          l.delivery ?? null,
          l.timeline ?? null,
          JSON.stringify(tags),
          JSON.stringify(state.flags),
          state.interests.join(", ") || null,
          state.completed,
        ],
      );
    },

    async latestChat(sessionId) {
      const sql = await getSql();
      const rows = await sql.query<DbChat>(`select ${CHAT_COLS} from chat_conversations where session_id = $1 order by started_at desc, seq desc limit 1`, [sessionId]);
      return rows[0] ? rowToChat(rows[0]) : null;
    },

    async getChat(chatId) {
      const sql = await getSql();
      const rows = await sql.query<DbChat>(`select ${CHAT_COLS} from chat_conversations where id = $1`, [chatId]);
      return rows[0] ? rowToChat(rows[0]) : null;
    },

    async startChat(input) {
      const sql = await getSql();
      const at = new Date(input.nowMs).toISOString();
      const rows = await sql.query<DbChat>(
        `insert into chat_conversations (id, session_id, source, ip_hash, started_at, last_message_at)
         values ($1, $2, $3, $4, $5, $5) returning ${CHAT_COLS}`,
        [input.id, input.sessionId, input.source, input.ipHash, at],
      );
      return rowToChat(rows[0]!);
    },

    async touchChat(input) {
      const sql = await getSql();
      const l = input.state.lead;
      await sql.query(
        `update chat_conversations set state = $2::jsonb, name = $3, phone = $4, city = $5,
           ip_hash = coalesce($6, ip_hash), user_messages = user_messages + 1,
           last_message_at = greatest(last_message_at, $7::timestamptz), updated_at = now()
         where id = $1`,
        [input.chatId, JSON.stringify(input.state), l.name ?? null, l.phone ?? null, l.city ?? null, input.ipHash, new Date(input.nowMs).toISOString()],
      );
    },

    async endChat(chatId, reason, nowMs) {
      const sql = await getSql();
      const rows = await sql.query(
        "update chat_conversations set ended_at = $3, end_reason = $2, updated_at = now() where id = $1 and ended_at is null returning id",
        [chatId, reason, new Date(nowMs).toISOString()],
      );
      return rows.length === 1;
    },

    async markChatClosed(chatId, nowMs) {
      const sql = await getSql();
      await sql.query("update chat_conversations set closed_at = coalesce(closed_at, $2), updated_at = now() where id = $1 and ended_at is null", [
        chatId,
        new Date(nowMs).toISOString(),
      ]);
    },

    async endIdleChats(input) {
      const sql = await getSql();
      const rows = await sql.query<{ id: string }>(
        `update chat_conversations set ended_at = $2, end_reason = case when closed_at is not null then 'closing' else 'idle' end, updated_at = now()
         where id in (
           select id from chat_conversations
           where ended_at is null and last_message_at < $1 and ($4::uuid is null or session_id <> $4::uuid)
           order by last_message_at asc limit $3
           for update skip locked
         ) and ended_at is null
         returning id`,
        [new Date(input.cutoffMs).toISOString(), new Date(input.nowMs).toISOString(), input.limit, input.excludeSessionId ?? null],
      );
      return rows.map((r) => String(r.id));
    },

    async claimChatEmail(input) {
      const sql = await getSql();
      const rows = await sql.query<DbChat>(
        `update chat_conversations set email_status = 'claimed', email_claimed_at = $2, email_attempts = email_attempts + 1, updated_at = now()
         where id = $1 and (
           email_status = 'pending'
           or ($4 and email_status = 'failed')
           or ($5 and email_status in ('failed', 'capped', 'off'))
           or (email_status = 'claimed' and email_claimed_at < $3)
         )
         returning ${CHAT_COLS}`,
        [input.chatId, new Date(input.nowMs).toISOString(), new Date(input.nowMs - CLAIM_STALE_MS).toISOString(), input.retryFailed, Boolean(input.digest)],
      );
      return rows[0] ? rowToChat(rows[0]) : null;
    },

    async chatEmailCaps(input) {
      const sql = await getSql();
      const rows = await sql.query<{ by_ip: number; global_1h: number }>(
        `select
           (select count(*)::int from chat_conversations where $1::text is not null and ip_hash = $1 and id <> $4 and email_status = 'sent' and email_via = 'instant' and email_kind = 'visitor' and emailed_at > $2) as by_ip,
           (select count(*)::int from chat_conversations where email_status = 'sent' and email_via = 'instant' and email_kind = 'visitor' and emailed_at > $3) as global_1h`,
        [input.ipHash, new Date(input.nowMs - 24 * 3600_000).toISOString(), new Date(input.nowMs - 3600_000).toISOString(), input.chatId],
      );
      return capVerdict({ byIp24h: Number(rows[0]?.by_ip ?? 0), global1h: Number(rows[0]?.global_1h ?? 0) }, input);
    },

    async finishChatEmail(f) {
      const sql = await getSql();
      const at = new Date(f.nowMs).toISOString();
      await sql.query(
        `update chat_conversations set email_status = $2, email_kind = $3, email_note = $4,
           email_via = case when $2 = 'sent' then $5 else email_via end,
           emailed_at = case when $2 = 'sent' then $6::timestamptz else emailed_at end,
           updated_at = now()
         where id = $1`,
        [f.chatId, f.status, f.kind, f.note ?? null, f.via, at],
      );
      if (f.via === "instant") {
        const status = auditStatus(f);
        await sql.query("insert into chat_alerts (session_id, chat_id, phone, ip_hash, status) values ($1, $2, $3, $4, $5)", [f.sessionId, f.chatId, f.phone, f.ipHash, status]);
        await sql.query("update chat_leads set alert_status = $2, updated_at = now() where session_id = $1", [f.sessionId, status]);
      }
    },

    async digestCandidates(input) {
      const sql = await getSql();
      const rows = await sql.query<DbChat>(
        `select ${CHAT_COLS} from chat_conversations
         where ended_at is not null and (
           email_status in ('failed', 'capped', 'off')
           or (email_status = 'pending' and (ended_at < $1 or id = any($4::uuid[])))
           or (email_status = 'claimed' and email_claimed_at < $2)
         )
         order by ended_at asc, seq asc limit $3`,
        [new Date(input.nowMs - input.settleMs).toISOString(), new Date(input.nowMs - CLAIM_STALE_MS).toISOString(), input.limit, input.includeIds ?? []],
      );
      return rows.map(rowToChat);
    },

    async pendingEndedChats(input) {
      const sql = await getSql();
      const rows = await sql.query<{ id: string }>(
        `select id from chat_conversations
         where ended_at is not null and (
           (email_status = 'pending' and ended_at <= $1)
           or (email_status = 'claimed' and email_claimed_at < $2)
         )
         order by ended_at asc, seq asc limit $3`,
        [new Date(input.endedBeforeMs).toISOString(), new Date(input.nowMs - CLAIM_STALE_MS).toISOString(), input.limit],
      );
      return rows.map((r) => String(r.id));
    },

    async chatTranscript(chatId) {
      const sql = await getSql();
      const rows = await sql.query<{ role: "user" | "bot"; text: string; created_at: string | Date }>(
        "select role, text, created_at from chat_messages where chat_id = $1 order by id asc limit 300",
        [chatId],
      );
      return rows.map((r) => ({ role: r.role, text: r.text, createdAt: r.created_at }));
    },

    async transcript(sessionId) {
      const sql = await getSql();
      const rows = await sql.query<{ role: "user" | "bot"; text: string; created_at: string | Date }>(
        "select role, text, created_at from chat_messages where session_id = $1 order by id asc limit 300",
        [sessionId],
      );
      return rows.map((r) => ({ role: r.role, text: r.text, createdAt: r.created_at }));
    },
  };
}

/** In-memory store (tests). Same rules as the SQL store. */
export function createMemoryChatStore() {
  const rate = new Map<string, number>();
  const sessions = new Map<string, { source: string; ipHash: string | null; state: ChatState }>();
  const messages: Array<MessageRow & { at: number }> = [];
  const leads = new Map<string, { source: string; state: ChatState; completed: boolean; alertStatus?: AlertStatus | AlertOutcome }>();
  const alerts: Array<{ sessionId: string; chatId: string | null; phone: string | null; ipHash: string | null; status: AlertStatus | AlertOutcome; at: number }> = [];
  const chats = new Map<string, ChatRow & { claimedAt: number | null; attempts: number }>();
  const copy = (c: ChatRow & { claimedAt: number | null; attempts: number }): ChatRow => {
    const { claimedAt: _c, attempts: _a, ...row } = c;
    return structuredClone(row);
  };
  const store: ChatStore & {
    sessions: typeof sessions;
    messages: typeof messages;
    leads: typeof leads;
    alerts: typeof alerts;
    chats: typeof chats;
  } = {
    sessions,
    messages,
    leads,
    alerts,
    chats,
    async hitRateLimit(bucket, windowSeconds, nowMs) {
      const key = `${bucket}@${windowStart(nowMs, windowSeconds).getTime()}`;
      const n = (rate.get(key) ?? 0) + 1;
      rate.set(key, n);
      return n;
    },
    async loadSession(id) {
      const s = sessions.get(id);
      return s ? structuredClone(s.state) : null;
    },
    async saveSession(id, source, ipHash, state) {
      sessions.set(id, { source, ipHash, state: structuredClone(state) });
    },
    async appendMessages(rows) {
      for (const r of rows) messages.push({ ...r, at: Date.now() });
    },
    async upsertLead(id, source, state) {
      if (!leadHasData(state)) return;
      const prev = leads.get(id);
      const merged = structuredClone(state);
      if (prev) {
        merged.lead.name ??= prev.state.lead.name;
        merged.lead.phone ??= prev.state.lead.phone;
        merged.lead.city ??= prev.state.lead.city;
      }
      leads.set(id, { source, state: merged, completed: Boolean(prev?.completed || state.completed), alertStatus: prev?.alertStatus });
    },
    async transcript(id) {
      return messages.filter((m) => m.sessionId === id).map((m) => ({ role: m.role, text: m.text }));
    },
    async latestChat(sessionId) {
      let best: (ChatRow & { claimedAt: number | null; attempts: number }) | null = null;
      for (const c of chats.values()) if (c.sessionId === sessionId && (!best || c.startedAt >= best.startedAt)) best = c;
      return best ? copy(best) : null;
    },
    async getChat(chatId) {
      const c = chats.get(chatId);
      return c ? copy(c) : null;
    },
    async startChat(input) {
      const row = {
        id: input.id,
        sessionId: input.sessionId,
        source: input.source,
        ipHash: input.ipHash,
        state: null,
        name: null,
        phone: null,
        city: null,
        userMessages: 0,
        startedAt: input.nowMs,
        lastMessageAt: input.nowMs,
        endedAt: null,
        endReason: null,
        closedAt: null,
        emailStatus: "pending" as ChatEmailStatus,
        emailKind: null,
        emailVia: null,
        emailedAt: null,
        emailNote: null,
        claimedAt: null,
        attempts: 0,
      };
      chats.set(input.id, row);
      return copy(row);
    },
    async touchChat(input) {
      const c = chats.get(input.chatId);
      if (!c) return;
      c.state = structuredClone(input.state);
      c.name = input.state.lead.name ?? null;
      c.phone = input.state.lead.phone ?? null;
      c.city = input.state.lead.city ?? null;
      c.ipHash = input.ipHash ?? c.ipHash;
      c.userMessages += 1;
      c.lastMessageAt = Math.max(c.lastMessageAt, input.nowMs);
    },
    async endChat(chatId, reason, nowMs) {
      const c = chats.get(chatId);
      if (!c || c.endedAt !== null) return false;
      c.endedAt = nowMs;
      c.endReason = reason;
      return true;
    },
    async markChatClosed(chatId, nowMs) {
      const c = chats.get(chatId);
      if (c && c.endedAt === null) c.closedAt ??= nowMs;
    },
    async endIdleChats(input) {
      const idle = [...chats.values()]
        .filter((c) => c.endedAt === null && c.lastMessageAt < input.cutoffMs && c.sessionId !== input.excludeSessionId)
        .sort((a, b) => a.lastMessageAt - b.lastMessageAt)
        .slice(0, input.limit);
      for (const c of idle) {
        c.endedAt = input.nowMs;
        c.endReason = c.closedAt !== null ? "closing" : "idle";
      }
      return idle.map((c) => c.id);
    },
    async claimChatEmail(input) {
      const c = chats.get(input.chatId);
      if (!c) return null;
      const ok =
        c.emailStatus === "pending" ||
        (input.retryFailed && c.emailStatus === "failed") ||
        (Boolean(input.digest) && ["failed", "capped", "off"].includes(c.emailStatus)) ||
        (c.emailStatus === "claimed" && (c.claimedAt ?? 0) < input.nowMs - CLAIM_STALE_MS);
      if (!ok) return null;
      c.emailStatus = "claimed";
      c.claimedAt = input.nowMs;
      c.attempts += 1;
      return copy(c);
    },
    async chatEmailCaps(input) {
      const sent = [...chats.values()].filter((c) => c.emailStatus === "sent" && c.emailVia === "instant" && c.emailKind === "visitor" && c.emailedAt !== null);
      return capVerdict(
        {
          byIp24h: input.ipHash ? sent.filter((c) => c.id !== input.chatId && c.ipHash === input.ipHash && c.emailedAt! > input.nowMs - 24 * 3600_000).length : 0,
          global1h: sent.filter((c) => c.emailedAt! > input.nowMs - 3600_000).length,
        },
        input,
      );
    },
    async finishChatEmail(f) {
      const c = chats.get(f.chatId);
      if (c) {
        c.emailStatus = f.status;
        c.emailKind = f.kind;
        c.emailNote = f.note ?? null;
        if (f.status === "sent") {
          c.emailVia = f.via;
          c.emailedAt = f.nowMs;
        }
      }
      if (f.via === "instant") {
        const status = auditStatus(f);
        alerts.push({ sessionId: f.sessionId, chatId: f.chatId, phone: f.phone, ipHash: f.ipHash, status, at: f.nowMs });
        const lead = leads.get(f.sessionId);
        if (lead) lead.alertStatus = status;
      }
    },
    async digestCandidates(input) {
      return [...chats.values()]
        .filter(
          (c) =>
            c.endedAt !== null &&
            (["failed", "capped", "off"].includes(c.emailStatus) ||
              (c.emailStatus === "pending" && (c.endedAt < input.nowMs - input.settleMs || (input.includeIds ?? []).includes(c.id))) ||
              (c.emailStatus === "claimed" && (c.claimedAt ?? 0) < input.nowMs - CLAIM_STALE_MS)),
        )
        .sort((a, b) => a.endedAt! - b.endedAt!)
        .slice(0, input.limit)
        .map(copy);
    },
    async pendingEndedChats(input) {
      return [...chats.values()]
        .filter(
          (c) =>
            c.endedAt !== null &&
            ((c.emailStatus === "pending" && c.endedAt <= input.endedBeforeMs) || (c.emailStatus === "claimed" && (c.claimedAt ?? 0) < input.nowMs - CLAIM_STALE_MS)),
        )
        .sort((a, b) => a.endedAt! - b.endedAt!)
        .slice(0, input.limit)
        .map((c) => c.id);
    },
    async chatTranscript(chatId) {
      return messages.filter((m) => m.chatId === chatId).map((m) => ({ role: m.role, text: m.text }));
    },
  };
  return store;
}
