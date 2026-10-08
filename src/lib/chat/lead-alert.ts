/**
 * Lead alert for Shiva: fired once per session as soon as the lead is
 * actionable (name + valid number captured, or the handoff completes).
 *
 * Channel is chosen by CHAT_LEAD_ALERT_MODE:
 *   unset / "off"  -> log a one-line note only (default; lead is still in the DB)
 *   "console"      -> log the formatted alert to the server log
 *   "email"        -> email Shiva via Resend (plain fetch, 5 s timeout)
 * Email env: RESEND_API_KEY, CHAT_LEAD_ALERT_EMAIL_TO, CHAT_LEAD_ALERT_FROM
 * (default "The Discus Den Chat <onboarding@resend.dev>").
 * Callers only use sendLeadAlert(); it never throws.
 */

import type { ChatState } from "./engine.ts";

/** LB-19: the chat (conversation) an email is about. */
export type ChatMeta = {
  id: string;
  startedAt: number;
  lastMessageAt: number;
  endedAt: number | null;
  endReason: "beacon" | "idle" | "closing" | null;
};

export type LeadForAlert = {
  sessionId: string;
  source: string;
  state: ChatState;
  /** LB-19: present for per-chat emails (Lead / Visitor). */
  chat?: ChatMeta;
};

/** LB-19 tags (Shiva, 8 Oct 11:37): Lead = a name AND a valid mobile were captured in this chat; otherwise Visitor. */
export function chatTag(s: ChatState): { tag: "Lead" | "Visitor"; likelyGenuine: boolean } {
  const tag = s.lead.phone && s.lead.name ? "Lead" : "Visitor";
  // Visitor with a name and a city: probably a real buyer even without a number.
  const likelyGenuine = tag === "Visitor" && !s.lead.phone && Boolean(s.lead.name && (s.lead.city || s.lead.stateName));
  return { tag, likelyGenuine };
}

const END_REASON: Record<string, string> = {
  beacon: "visitor closed the chat",
  idle: "10 min with no messages",
  closing: "closing message after details were collected",
};

/** LB-19: Tag / Name / Phone / City / Source / timestamps block (top of every chat email). */
export function chatHeaderLines(lead: LeadForAlert): string[] {
  const s = lead.state;
  const { tag, likelyGenuine } = chatTag(s);
  const lines = [
    `Tag:         ${tag}${likelyGenuine ? " · likely genuine" : ""}`,
    `Name:        ${s.lead.name ?? "not given"}`,
    `Phone:       ${s.lead.phone ?? "not given"}`,
    `City:        ${s.lead.city ?? s.lead.stateName ?? "not given"}`,
    `Source:      ?from=${lead.source || "direct"}`,
  ];
  if (s.prior && (s.prior.name || s.prior.phone)) {
    lines.push(`Earlier chat: ${[s.prior.name, s.prior.phone, s.prior.city].filter(Boolean).join(", ")} (same browser)`);
  }
  if (s.badNumbers) lines.push(`Note:        typed a number that failed the 10-digit mobile check`);
  if (lead.chat) {
    lines.push(`Chat started: ${istTime(new Date(lead.chat.startedAt))}`);
    lines.push(`Last message: ${istTime(new Date(lead.chat.lastMessageAt))}`);
    lines.push(
      lead.chat.endedAt
        ? `Chat ended:   ${istTime(new Date(lead.chat.endedAt))} (${END_REASON[lead.chat.endReason ?? ""] ?? "ended"})`
        : `Chat ended:   not recorded`,
    );
    lines.push(`Chat id:     ${lead.chat.id}`);
  }
  return lines;
}

export type TranscriptLine = { role: "user" | "bot"; text: string; createdAt?: string | Date };

function istTime(d: Date): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${fmt.format(d).replace(/,(?=[^,]*$)/, ",")} IST`;
}

function interestLine(s: ChatState): string {
  const bits: string[] = [];
  if (s.tags.history) bits.push(s.tags.history === "first-timer" ? "First-timer" : "Returning");
  if (s.lead.city) bits.push(s.lead.city);
  if (s.interests.length) bits.push(`asked about ${s.interests.slice(0, 3).join(", ")}`);
  if (s.lead.lookingFor) bits.push(`looking for ${s.lead.lookingFor}`);
  if (s.lead.timeline) bits.push(s.lead.timeline);
  return bits.join(", ") || "General enquiry";
}

/** Plain-text alert in the format from the sales answer pack (section 3). */
export function formatLeadAlert(lead: LeadForAlert, now: Date = new Date()): string {
  const s = lead.state;
  const l = s.lead;
  const in8 = l.inShipStates === true ? "Y" : l.inShipStates === false ? "N" : "not sure";
  const tags = [s.tags.buyer, s.tags.history, s.tags.heat ?? "browsing"].filter(Boolean).join(" · ");
  return [
    "TDD CHAT LEAD",
    `Name:        ${l.name ?? "not given"}`,
    `WhatsApp:    ${l.phone ?? "not given"}`,
    `City:        ${l.city ?? "not given"}  (State: ${l.stateName ?? "unknown"} | In 8 states: ${in8})`,
    // LB-11: fish-or-food replaces the old pair/single line; left out where the path doesn't ask it (DOA, sick fish).
    ...(s.handoff.skip?.includes("lookingFor") && !l.lookingFor ? [] : [`Looking for: ${l.lookingFor ?? "not sure"}`]),
    `Delivery:    ${l.inShipStates === false ? "not asked (OUTSIDE 8 STATES)" : l.delivery ?? "not sure"}`,
    `Timeline:    ${l.timeline ?? "not sure"}`,
    `Tags:        ${tags}`,
    `Source:      ?from=${lead.source || "direct"}`,
    `Interest:    ${interestLine(s)}`,
    `Flags:       ${s.flags.length ? s.flags.join(" · ") : "none"}`,
    `Time:        ${istTime(now)}`,
  ].join("\n");
}

export function formatTranscript(lines: TranscriptLine[]): string {
  return lines.map((m) => `${m.role === "user" ? "Visitor" : "Bot"}: ${m.text}`).join("\n");
}

// ---------------------------------------------------------------------------
// Email alert (Resend, plain fetch)
// ---------------------------------------------------------------------------

export const RESEND_ENDPOINT = "https://api.resend.com/emails";
export const DEFAULT_ALERT_FROM = "The Discus Den Chat <onboarding@resend.dev>";
export const DEFAULT_ALERT_TIMEOUT_MS = 5_000;

export type LeadAlertEmail = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
};

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/** First email address the CUSTOMER typed (bot lines are ignored). */
export function customerEmailFromTranscript(lines: TranscriptLine[]): string | null {
  for (const m of lines) {
    if (m.role !== "user") continue;
    const hit = m.text.match(EMAIL_RE);
    if (hit) return hit[0];
  }
  return null;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function oneLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

/** Short summary for the subject: tags/flags first, then strains, place, fish-or-food. */
export function leadSummary(s: ChatState): string {
  const bits: string[] = [];
  for (const f of s.flags) bits.push(f);
  if (s.interests.length) bits.push(s.interests.slice(0, 2).join(", "));
  const place = s.lead.city ?? s.lead.stateName;
  if (place) bits.push(place);
  if (s.lead.lookingFor) bits.push(s.lead.lookingFor);
  if (!bits.length) bits.push(s.tags.history === "first-timer" ? "First-timer enquiry" : "General enquiry");
  const out = oneLine(bits.join(" · "));
  return out.length > 110 ? `${out.slice(0, 107).trimEnd()}...` : out;
}

/** Build the Resend payload. Contains only what the customer typed + bot replies + lead fields. */
export function buildLeadAlertEmail(
  lead: LeadForAlert,
  transcript: TranscriptLine[],
  opts: { to: string; from?: string; now?: Date },
): LeadAlertEmail {
  const s = lead.state;
  const name = oneLine(s.lead.name ?? "Unnamed visitor");
  const email = customerEmailFromTranscript(transcript);
  const summary = leadSummary(s);
  const { tag, likelyGenuine } = chatTag(s);
  // LB-19: every subject is tagged Lead or Visitor.
  const subject = oneLine(
    tag === "Lead" ? `[Lead] New chat lead: ${name} — ${summary}` : `[Visitor${likelyGenuine ? " · likely genuine" : ""}] Website chat: ${name} — ${summary}`,
  ).slice(0, 200);
  const header = chatHeaderLines(lead);
  const card = formatLeadAlert(lead, opts.now ?? new Date());
  const contact = [
    `Phone/WhatsApp: ${s.lead.phone ?? "not given"}`,
    `Email: ${email ?? "not given"}`,
  ];
  const flagsLine = s.flags.length ? s.flags.join(" · ") : "none";

  const text = [
    tag === "Lead" ? `New lead from The Discus Den website chat.` : `New visitor chat on The Discus Den website (no name + number given).`,
    ``,
    ...header,
    ``,
    `Customer: ${name}`,
    ...contact,
    `Summary: ${summary}`,
    `Tags: ${flagsLine}`,
    ``,
    card,
    ``,
    `--- Full chat transcript ---`,
    formatTranscript(transcript),
    ``,
    `Session: ${lead.sessionId}`,
  ].join("\n");

  const rows = transcript
    .map((m) => {
      const who = m.role === "user" ? "Visitor" : "Bot";
      const colour = m.role === "user" ? "#0b3d5c" : "#555";
      return `<tr><td style="vertical-align:top;padding:4px 8px;font-weight:bold;color:${colour};white-space:nowrap">${who}</td><td style="padding:4px 8px;white-space:pre-wrap">${escapeHtml(m.text)}</td></tr>`;
    })
    .join("");
  const html = [
    `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.45;color:#111">`,
    `<h2 style="margin:0 0 8px">${tag === "Lead" ? "New chat lead" : "Website chat"}: ${escapeHtml(name)} <span style="font-size:13px;background:${tag === "Lead" ? "#0b7a3b" : "#666"};color:#fff;padding:2px 8px;border-radius:10px">${tag}${likelyGenuine ? " · likely genuine" : ""}</span></h2>`,
    `<pre style="margin:0 0 12px;font-size:12px">${escapeHtml(header.join("\n"))}</pre>`,
    `<p style="margin:0 0 12px"><strong>Summary:</strong> ${escapeHtml(summary)}</p>`,
    `<ul style="margin:0 0 12px;padding-left:18px">`,
    `<li><strong>Phone/WhatsApp:</strong> ${escapeHtml(s.lead.phone ?? "not given")}</li>`,
    `<li><strong>Email:</strong> ${escapeHtml(email ?? "not given")}</li>`,
    `<li><strong>Tags:</strong> ${escapeHtml(flagsLine)}</li>`,
    `</ul>`,
    `<pre style="background:#f4f6f8;padding:10px;border-radius:6px;font-size:12px">${escapeHtml(card)}</pre>`,
    `<h3 style="margin:16px 0 6px">Full chat transcript</h3>`,
    `<table style="border-collapse:collapse;width:100%">${rows}</table>`,
    `<p style="color:#888;font-size:12px;margin-top:16px">Session ${escapeHtml(lead.sessionId)} · sent by The Discus Den website chat</p>`,
    `</div>`,
  ].join("");

  return { from: opts.from ?? DEFAULT_ALERT_FROM, to: [opts.to], subject, text, html };
}

export type LeadAlertResult = {
  sent: boolean;
  channel: "off" | "console" | "email";
  error?: string;
};

export type AlertFetch = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

type Env = Record<string, string | undefined>;

function timeoutMs(env: Env): number {
  const n = Number(env.CHAT_LEAD_ALERT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10_000) : DEFAULT_ALERT_TIMEOUT_MS;
}

/**
 * Sends the lead alert. Never throws.
 *   CHAT_LEAD_ALERT_MODE unset / "off" -> log only (no lead details logged)
 *   "console" -> log the formatted alert
 *   "email"   -> email via Resend (RESEND_API_KEY, CHAT_LEAD_ALERT_EMAIL_TO, CHAT_LEAD_ALERT_FROM)
 */
export async function sendLeadAlert(
  lead: LeadForAlert,
  transcript: TranscriptLine[],
  env: Env = typeof process !== "undefined" ? process.env : {},
  fetchImpl: AlertFetch = (url, init) => fetch(url, init),
): Promise<LeadAlertResult> {
  return deliver(
    {
      what: "lead alert",
      consoleText: () => `[chat-lead-alert]\n${chatHeaderLines(lead).join("\n")}\n${formatLeadAlert(lead)}\n--- transcript ---\n${formatTranscript(transcript)}`,
      payload: (to, from) => buildLeadAlertEmail(lead, transcript, { to, from }),
      // Resend dedupes the same key for 24 h. LB-19: keyed per CHAT (a session holds many
      // chats; the old per-session key would have silently swallowed a returning visitor's email).
      idempotencyKey: lead.chat ? `tdd-chat-${lead.chat.id}` : `tdd-chat-lead-${lead.sessionId}`,
    },
    env,
    fetchImpl,
  );
}

// ---------------------------------------------------------------------------
// LB-19: daily digest of ended chats that were never emailed
// ---------------------------------------------------------------------------

export type DigestItem = { lead: LeadForAlert; transcript: TranscriptLine[]; status: string; note?: string | null };

const DIGEST_TRANSCRIPT_LINES = 60;

export function buildDigestEmail(items: DigestItem[], opts: { to: string; from?: string; now?: Date; more?: number }): LeadAlertEmail {
  const now = opts.now ?? new Date();
  const leads = items.filter((i) => chatTag(i.lead.state).tag === "Lead").length;
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }).format(now);
  const subject = oneLine(`[Digest] ${items.length} website chat${items.length === 1 ? "" : "s"} not emailed yet (${leads} Lead) — ${day}`).slice(0, 200);
  const why = (i: DigestItem) =>
    i.status === "capped" ? `held back by the ${i.note === "ip_cap" ? "per-IP" : "hourly"} email cap` : i.status === "off" ? "email was switched off (CHAT_LEAD_ALERT_MODE)" : i.status === "failed" ? `email failed${i.note ? ` (${i.note})` : ""}` : "not emailed when it ended";
  const blocks = items.map((i, n) => {
    const lines = i.transcript.length > DIGEST_TRANSCRIPT_LINES ? [...i.transcript.slice(0, DIGEST_TRANSCRIPT_LINES), { role: "bot" as const, text: `[... ${i.transcript.length - DIGEST_TRANSCRIPT_LINES} more lines]` }] : i.transcript;
    return [`#${n + 1} — ${why(i)}`, ...chatHeaderLines(i.lead), `--- transcript ---`, formatTranscript(lines)].join("\n");
  });
  const text = [
    `Daily digest from The Discus Den website chat: chats that ended without an email reaching you.`,
    opts.more ? `(${opts.more} more will follow in the next digest.)` : ``,
    ``,
    blocks.join("\n\n==========\n\n"),
  ].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111"><h2 style="margin:0 0 8px">${escapeHtml(subject)}</h2>${blocks
    .map((b) => `<pre style="background:#f4f6f8;padding:10px;border-radius:6px;font-size:12px;white-space:pre-wrap">${escapeHtml(b)}</pre>`)
    .join("")}</div>`;
  return { from: opts.from ?? DEFAULT_ALERT_FROM, to: [opts.to], subject, text, html };
}

export async function sendChatDigest(
  items: DigestItem[],
  env: Env = typeof process !== "undefined" ? process.env : {},
  fetchImpl: AlertFetch = (url, init) => fetch(url, init),
  more = 0,
): Promise<LeadAlertResult> {
  const ids = items.map((i) => i.lead.chat?.id ?? i.lead.sessionId).sort().join(",");
  let h = 0;
  for (let k = 0; k < ids.length; k += 1) h = (Math.imul(h, 31) + ids.charCodeAt(k)) | 0;
  return deliver(
    {
      what: "chat digest",
      consoleText: () => buildDigestEmail(items, { to: "console", more }).text,
      payload: (to, from) => buildDigestEmail(items, { to, from, more }),
      idempotencyKey: `tdd-chat-digest-${(h >>> 0).toString(36)}-${items.length}`,
    },
    env,
    fetchImpl,
  );
}

/** Shared channel logic (off / console / email via Resend). Never throws. */
async function deliver(
  job: { what: string; consoleText: () => string; payload: (to: string, from: string) => LeadAlertEmail; idempotencyKey: string },
  env: Env,
  fetchImpl: AlertFetch,
): Promise<LeadAlertResult> {
  const mode = (env.CHAT_LEAD_ALERT_MODE ?? "off").trim().toLowerCase();

  if (mode === "console") {
    try {
      console.log(job.consoleText());
      return { sent: true, channel: "console" };
    } catch {
      return { sent: false, channel: "console" };
    }
  }

  if (mode !== "email") {
    console.log(`[chat] ${job.what} not sent: CHAT_LEAD_ALERT_MODE is off (lead stored in DB)`);
    return { sent: false, channel: "off" };
  }

  const apiKey = env.RESEND_API_KEY?.trim();
  const to = env.CHAT_LEAD_ALERT_EMAIL_TO?.trim();
  if (!apiKey || !to) {
    const missing = [!apiKey && "RESEND_API_KEY", !to && "CHAT_LEAD_ALERT_EMAIL_TO"].filter(Boolean).join(" and ");
    console.warn(`[chat] ${job.what} failed: CHAT_LEAD_ALERT_MODE=email but ${missing} is not set (lead stored in DB)`);
    return { sent: false, channel: "email", error: `missing ${missing}` };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs(env));
  try {
    const payload = job.payload(to, env.CHAT_LEAD_ALERT_FROM?.trim() || DEFAULT_ALERT_FROM);
    const res = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": job.idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      console.warn(`[chat] ${job.what} failed: Resend HTTP ${res.status} ${detail}`);
      return { sent: false, channel: "email", error: `http ${res.status}` };
    }
    // LB-7: positive evidence in the runtime log (no lead details, no key).
    let id: string | undefined;
    try {
      id = (await res.text()).match(/"id"\s*:\s*"([^"]{1,80})"/)?.[1];
    } catch {
      id = undefined;
    }
    console.log(`[chat] ${job.what} sent: email via Resend${id ? ` id=${id}` : ""}`);
    return { sent: true, channel: "email" };
  } catch (err) {
    const msg = ctrl.signal.aborted ? "timeout" : err instanceof Error ? err.message : String(err);
    console.warn(`[chat] ${job.what} failed: ${msg}`);
    return { sent: false, channel: "email", error: msg };
  } finally {
    clearTimeout(timer);
  }
}
