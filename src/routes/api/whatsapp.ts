import { createFileRoute } from "@tanstack/react-router";
import { handleWebhookGet, handleWebhookPost } from "@/lib/whatsapp/webhook";

/**
 * WhatsApp Cloud API webhook (TanStack Start / Nitro -> Vercel).
 * Logic + kill switch (WHATSAPP_FRONT_DESK_ENABLED) live in src/lib/whatsapp/webhook.ts.
 */
export const Route = createFileRoute("/api/whatsapp")({
  server: {
    handlers: {
      GET: ({ request }) => handleWebhookGet(request),
      POST: ({ request }) => handleWebhookPost(request),
    },
  },
});
