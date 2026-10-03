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

export type AlertStatus = "sent" | "suppressed_duplicate" | "suppressed_ip_cap" | "suppressed_global_cap";
/** What happened after a "sent" decision when the alert did not go out (LB-7). */
export type AlertOutcome = "failed" | "not_sent_off";
export type AlertDecisionInput = {
  sessionId: string;
  phone: string | null;
  ipHash: string | null;
  ipCap: number;
  globalCap: number;
  nowMs: number;
};

/** Shared decision rule (DB counts are passed in). */
export function alertDecision(
  counts: { byPhone24h: number; byIp24h: number; global1h: number },
  input: Pick<AlertDecisionInput, "phone" | "ipHash" | "ipCap" | "globalCap">,
): AlertStatus {
  if (input.phone && counts.byPhone24h > 0) return "suppressed_duplicate";
  if (input.ipHash && counts.byIp24h >= input.ipCap) return "suppressed_ip_cap";
  if (counts.global1h >= input.globalCap) return "suppressed_global_cap";
  return "sent";
}

export type MessageRow = {
  sessionId: string;
  role: "user" | "bot";
  text: string;
  source: string;
  ipHash: string | null;
  intent?: string | null;
};

export interface ChatStore {
  /** Count one hit in a fixed window; returns the hit count after this one. */
  hitRateLimit(bucket: string, windowSeconds: number, nowMs: number): Promise<number>;
  loadSession(sessionId: string): Promise<ChatState | null>;
  saveSession(sessionId: string, source: string, ipHash: string | null, state: ChatState): Promise<void>;
  appendMessages(rows: MessageRow[]): Promise<void>;
  upsertLead(sessionId: string, source: string, state: ChatState): Promise<void>;
  /**
   * True exactly once per lead (atomic), as soon as it is actionable: the
   * handoff completed, or name + valid number are both captured (LB-7).
   */
  claimLeadAlert(sessionId: string): Promise<boolean>;
  /**
   * Flood control for lead alerts, counted in the DB: one alert per phone per
   * 24 h, at most `ipCap` per IP hash per 24 h, at most `globalCap` per hour.
   * Records the decision (sent or suppressed_*) and returns it.
   */
  decideLeadAlert(input: AlertDecisionInput): Promise<AlertStatus>;
  /**
   * LB-7: a "sent" decision whose alert did not actually go out is rewritten to
   * `outcome`, so it stops counting toward the phone / IP / global caps.
   */
  recordAlertOutcome(sessionId: string, outcome: AlertOutcome): Promise<void>;
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
        params.push(r.sessionId, r.role, r.text, r.source, r.ipHash, r.intent ?? null);
        const b = i * 6;
        // clock_timestamp() keeps user-before-bot ordering visible in created_at too.
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, clock_timestamp())`;
      });
      await sql.query(
        `insert into chat_messages (session_id, role, text, source, ip_hash, intent, created_at) values ${values.join(", ")}`,
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
           name = excluded.name, phone = excluded.phone, city = excluded.city, state_name = excluded.state_name,
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

    async claimLeadAlert(sessionId) {
      const sql = await getSql();
      const rows = await sql.query(
        `update chat_leads set alert_sent_at = now()
         where session_id = $1 and alert_sent_at is null
           and (completed or (name is not null and phone is not null))
         returning session_id`,
        [sessionId],
      );
      return rows.length === 1;
    },

    async decideLeadAlert(input) {
      const sql = await getSql();
      // One statement: count + decide + record, so concurrent requests see each other's rows
      // as soon as they commit (small races can let one extra through; caps are soft limits).
      const rows = await sql.query<{ status: AlertStatus }>(
        `with c as (
           select
             (select count(*) from chat_alerts where $2::text is not null and phone = $2 and status = 'sent' and created_at > now() - interval '24 hours') as by_phone,
             (select count(*) from chat_alerts where $3::text is not null and ip_hash = $3 and status = 'sent' and created_at > now() - interval '24 hours') as by_ip,
             (select count(*) from chat_alerts where status = 'sent' and created_at > now() - interval '1 hour') as global_1h
         )
         insert into chat_alerts (session_id, phone, ip_hash, status)
         select $1, $2, $3,
           case
             when $2::text is not null and by_phone > 0 then 'suppressed_duplicate'
             when $3::text is not null and by_ip >= $4 then 'suppressed_ip_cap'
             when global_1h >= $5 then 'suppressed_global_cap'
             else 'sent'
           end
         from c
         returning status`,
        [input.sessionId, input.phone, input.ipHash, input.ipCap, input.globalCap],
      );
      const status = rows[0]?.status ?? "suppressed_global_cap";
      await sql.query("update chat_leads set alert_status = $2, updated_at = now() where session_id = $1", [input.sessionId, status]);
      return status;
    },

    async recordAlertOutcome(sessionId, outcome) {
      const sql = await getSql();
      await sql.query("update chat_alerts set status = $2 where session_id = $1 and status = 'sent'", [sessionId, outcome]);
      await sql.query("update chat_leads set alert_status = $2, updated_at = now() where session_id = $1", [sessionId, outcome]);
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

/** In-memory store (tests). */
export function createMemoryChatStore() {
  const rate = new Map<string, number>();
  const sessions = new Map<string, { source: string; ipHash: string | null; state: ChatState }>();
  const messages: Array<MessageRow & { at: number }> = [];
  const leads = new Map<string, { source: string; state: ChatState; completed: boolean; alertSent: boolean; alertStatus?: AlertStatus | AlertOutcome }>();
  const alerts: Array<{ sessionId: string; phone: string | null; ipHash: string | null; status: AlertStatus | AlertOutcome; at: number }> = [];
  const store: ChatStore & {
    sessions: typeof sessions;
    messages: typeof messages;
    leads: typeof leads;
    alerts: typeof alerts;
  } = {
    sessions,
    messages,
    leads,
    alerts,
    async decideLeadAlert(input) {
      const sent = alerts.filter((a) => a.status === "sent");
      const day = input.nowMs - 24 * 3600_000;
      const hour = input.nowMs - 3600_000;
      const status = alertDecision(
        {
          byPhone24h: input.phone ? sent.filter((a) => a.phone === input.phone && a.at > day).length : 0,
          byIp24h: input.ipHash ? sent.filter((a) => a.ipHash === input.ipHash && a.at > day).length : 0,
          global1h: sent.filter((a) => a.at > hour).length,
        },
        input,
      );
      alerts.push({ sessionId: input.sessionId, phone: input.phone, ipHash: input.ipHash, status, at: input.nowMs });
      const lead = leads.get(input.sessionId);
      if (lead) lead.alertStatus = status;
      return status;
    },
    async recordAlertOutcome(id, outcome) {
      for (const a of alerts) if (a.sessionId === id && a.status === "sent") a.status = outcome;
      const lead = leads.get(id);
      if (lead) lead.alertStatus = outcome;
    },
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
      leads.set(id, {
        source,
        state: structuredClone(state),
        completed: Boolean(prev?.completed || state.completed),
        alertSent: prev?.alertSent ?? false,
        alertStatus: prev?.alertStatus,
      });
    },
    async claimLeadAlert(id) {
      const l = leads.get(id);
      if (!l || l.alertSent) return false;
      if (!l.completed && !(l.state.lead.name && l.state.lead.phone)) return false;
      l.alertSent = true;
      return true;
    },
    async transcript(id) {
      return messages.filter((m) => m.sessionId === id).map((m) => ({ role: m.role, text: m.text }));
    },
  };
  return store;
}
