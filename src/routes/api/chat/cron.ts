import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { createCatalogLoader, priceCacheMsFromEnv } from "@/lib/chat/catalog";
import { handleChatCron } from "@/lib/chat/http";
import { createSqlChatStore } from "@/lib/chat/store";

/**
 * LB-19: daily safety net (Vercel cron, once a day; see vercel.json / vite.config.ts).
 * Ends idle chats and emails Shiva ONE digest of ended chats that never got their email.
 * Env: CRON_SECRET (Vercel sends "Authorization: Bearer <CRON_SECRET>"); set it in Vercel.
 */

const store = createSqlChatStore(getSql);
const catalog = createCatalogLoader({ cacheMs: priceCacheMsFromEnv(process.env) });

const run = ({ request }: { request: Request }) => handleChatCron(request, { store, catalog, env: process.env });

export const Route = createFileRoute("/api/chat/cron")({
  server: {
    handlers: { GET: run, POST: run },
  },
});
