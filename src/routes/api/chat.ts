import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { createCatalogLoader, priceCacheMsFromEnv } from "@/lib/chat/catalog";
import { handleChatRequest, handleOptions } from "@/lib/chat/http";
import { createSqlChatStore } from "@/lib/chat/store";

/**
 * The Discus Den website Chat Assistant API.
 * POST /api/chat  { sessionId, message, source } -> { reply, handoff }
 * OPTIONS         CORS preflight for thediscusden.com (+ CHAT_EXTRA_ORIGINS)
 *
 * Env (Vercel; optional):
 *   CHAT_EXTRA_ORIGINS    comma list of extra allowed origins (previews)
 *   CHAT_IP_SALT          salt for hashing visitor IPs (set a random value)
 *   CHAT_LEAD_ALERT_MODE  "off" (default, log only) | "console" | "email"
 *   RESEND_API_KEY        Resend API key (sending access), needed for mode=email
 *   CHAT_LEAD_ALERT_EMAIL_TO   lead alert recipient (Shiva's inbox), needed for mode=email
 *   CHAT_LEAD_ALERT_FROM       sender, default "The Discus Den Chat <onboarding@resend.dev>"
 *   CHAT_LEAD_ALERT_TIMEOUT_MS email send timeout, default 5000
 *   CHAT_PRICE_CACHE_SECONDS   live-price cache TTL, default 60; 0 = always live
 *   CHAT_ALERT_IP_CAP_24H      max Visitor chat emails per IP hash per 24 h (default 3; Leads skip it)
 *   CHAT_ALERT_GLOBAL_CAP_HOUR max chat emails per hour overall (default 20; over it -> daily digest)
 *   CHAT_IDLE_MINUTES          a chat ends after this many quiet minutes (default 10)
 *   CRON_SECRET                REQUIRED for /api/chat/cron (Vercel sends it as a Bearer token); unset = cron rejected (401)
 *
 * LB-19: one email per CHAT, sent when the chat ends (see docs/chat-lead-alerts.md,
 * /api/chat/end and /api/chat/cron).
 */

const store = createSqlChatStore(getSql);
const catalog = createCatalogLoader({ cacheMs: priceCacheMsFromEnv(process.env) });

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => handleOptions(request, process.env),
      POST: ({ request }) => handleChatRequest(request, { store, catalog, env: process.env }),
      GET: ({ request }) => handleChatRequest(request, { store, catalog, env: process.env }),
    },
  },
});
