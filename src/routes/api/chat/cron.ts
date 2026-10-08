import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { createCatalogLoader, priceCacheMsFromEnv } from "@/lib/chat/catalog";
import { handleChatCron } from "@/lib/chat/http";
import { createSqlChatStore } from "@/lib/chat/store";

/**
 * LB-19: daily safety net (Vercel cron, once a day; see vercel.json / vite.config.ts).
 * Ends idle chats, emails each of them in the same run, then emails Shiva ONE digest of
 * ended chats that still have no email (failed / capped / over the run's limit).
 * Env: CRON_SECRET is REQUIRED (Vercel sends "Authorization: Bearer <CRON_SECRET>").
 * Without it every request is rejected with 401 (fail closed) and an error is logged.
 */

const store = createSqlChatStore(getSql);
const catalog = createCatalogLoader({ cacheMs: priceCacheMsFromEnv(process.env) });

const run = ({ request }: { request: Request }) => handleChatCron(request, { store, catalog, env: process.env });

export const Route = createFileRoute("/api/chat/cron")({
  server: {
    handlers: { GET: run, POST: run },
  },
});
