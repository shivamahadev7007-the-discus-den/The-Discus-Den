import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { createCatalogLoader, priceCacheMsFromEnv } from "@/lib/chat/catalog";
import { handleChatEnd, handleOptions } from "@/lib/chat/http";
import { createSqlChatStore } from "@/lib/chat/store";

/**
 * LB-19: the site widget calls this when the chat closes (close button / pagehide):
 *   navigator.sendBeacon("https://wa.thediscusden.com/api/chat/end", JSON.stringify({ sessionId }))
 * Ends the open chat and sends its one email (Visitor, or a Lead retry) if not sent yet.
 * Accepts text/plain (sendBeacon's default) and application/json. Idempotent; 204.
 */

const store = createSqlChatStore(getSql);
const catalog = createCatalogLoader({ cacheMs: priceCacheMsFromEnv(process.env) });

export const Route = createFileRoute("/api/chat/end")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => handleOptions(request, process.env),
      POST: ({ request }) => handleChatEnd(request, { store, catalog, env: process.env }),
    },
  },
});
