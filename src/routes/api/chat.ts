import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { createCatalogLoader } from "@/lib/chat/catalog";
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
 *   CHAT_LEAD_ALERT_MODE  "off" (default) | "console"
 */

const store = createSqlChatStore(getSql);
const catalog = createCatalogLoader();

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => handleOptions(request, process.env),
      POST: ({ request }) => handleChatRequest(request, { store, catalog, env: process.env }),
      GET: ({ request }) => handleChatRequest(request, { store, catalog, env: process.env }),
    },
  },
});
