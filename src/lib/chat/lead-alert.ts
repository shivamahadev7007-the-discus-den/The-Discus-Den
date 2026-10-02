/**
 * Lead alert for Shiva: fired once per session when a handoff completes
 * (name + valid number captured).
 *
 * The delivery channel (email vs Telegram) is still undecided, so this is a
 * stub behind CHAT_LEAD_ALERT_MODE:
 *   unset / "off"  -> no-op (default)
 *   "console"      -> log the formatted alert to the server log
 * Add the real sender here later; callers only use sendLeadAlert().
 */

import type { ChatState } from "./engine.ts";

export type LeadForAlert = {
  sessionId: string;
  source: string;
  state: ChatState;
};

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
  if (s.lead.pairSingle) bits.push(`wants ${s.lead.pairSingle}`);
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
    `Pair/Single: ${l.pairSingle ?? "not sure"}`,
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

export type LeadAlertResult = { sent: boolean; channel: "off" | "console" };

/** Stub sender. Never throws. */
export async function sendLeadAlert(
  lead: LeadForAlert,
  transcript: TranscriptLine[],
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): Promise<LeadAlertResult> {
  const mode = (env.CHAT_LEAD_ALERT_MODE ?? "off").trim().toLowerCase();
  if (mode !== "console") return { sent: false, channel: "off" };
  try {
    console.log(`[chat-lead-alert]\n${formatLeadAlert(lead)}\n--- transcript ---\n${formatTranscript(transcript)}`);
    return { sent: true, channel: "console" };
  } catch {
    return { sent: false, channel: "console" };
  }
}
