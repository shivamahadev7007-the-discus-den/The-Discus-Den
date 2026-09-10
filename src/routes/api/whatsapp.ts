import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * WhatsApp Cloud API webhook (TanStack Start / Nitro → Vercel).
 * Same contract as api/whatsapp.ts — Meta verify (GET) + inbound accept (POST).
 *
 * Env (Vercel; never commit):
 *   WHATSAPP_VERIFY_TOKEN
 *   WHATSAPP_APP_SECRET (optional; X-Hub-Signature-256)
 */

function verifySignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  try {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(provided, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function summarizeInbound(payload: unknown): string {
  try {
    const root = payload as {
      object?: string;
      entry?: Array<{
        changes?: Array<{
          field?: string;
          value?: {
            messages?: Array<{ from?: string; type?: string; id?: string }>;
            statuses?: Array<{ id?: string; status?: string }>;
            metadata?: { phone_number_id?: string };
          };
        }>;
      }>;
    };
    const change = root?.entry?.[0]?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    const status = value?.statuses?.[0];
    if (msg) {
      return `inbound message type=${msg.type ?? "?"} from=${msg.from ?? "?"} id=${msg.id ?? "?"} phone_number_id=${value?.metadata?.phone_number_id ?? "?"}`;
    }
    if (status) {
      return `status update id=${status.id ?? "?"} status=${status.status ?? "?"}`;
    }
    return `object=${root?.object ?? "?"} field=${change?.field ?? "?"}`;
  } catch {
    return "unparsed payload";
  }
}

async function handleGet(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (
    mode === "subscribe" &&
    verifyToken &&
    token === verifyToken &&
    challenge
  ) {
    return new Response(challenge, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response("Forbidden", { status: 403 });
}

async function handlePost(request: Request): Promise<Response> {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const rawBody = await request.text();

  if (appSecret) {
    const sig = request.headers.get("x-hub-signature-256");
    if (!verifySignature(rawBody, sig, appSecret)) {
      console.warn("[whatsapp-webhook] invalid X-Hub-Signature-256");
      return new Response("Forbidden", { status: 403 });
    }
  }

  let parsed: unknown = null;
  if (rawBody) {
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      parsed = null;
    }
  }

  console.log(`[whatsapp-webhook] ${summarizeInbound(parsed)}`);
  return Response.json({ ok: true });
}

export const Route = createFileRoute("/api/whatsapp")({
  server: {
    handlers: {
      GET: ({ request }) => handleGet(request),
      POST: ({ request }) => handlePost(request),
    },
  },
});
