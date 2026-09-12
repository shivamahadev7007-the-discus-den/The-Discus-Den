import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "node:crypto";
import { handleFrontDeskMessage } from "@/lib/whatsapp/front-desk";
import { sendWhatsAppText } from "@/lib/whatsapp/send";

/**
 * WhatsApp Cloud API webhook (TanStack Start / Nitro → Vercel).
 * GET  — Meta hub challenge verification (unchanged)
 * POST — inbound text → FE-2 front-desk engine → optional Graph reply
 *
 * Env (Vercel; never commit):
 *   WHATSAPP_VERIFY_TOKEN
 *   WHATSAPP_APP_SECRET (optional; X-Hub-Signature-256)
 *   WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID (optional; outbound)
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

type InboundMessage = {
  from?: string;
  type?: string;
  id?: string;
  text?: { body?: string };
};

type WebhookValue = {
  messages?: InboundMessage[];
  statuses?: Array<{ id?: string; status?: string }>;
  metadata?: { phone_number_id?: string };
};

function summarizeInbound(payload: unknown): string {
  try {
    const root = payload as {
      object?: string;
      entry?: Array<{
        changes?: Array<{
          field?: string;
          value?: WebhookValue;
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

function extractTextMessages(payload: unknown): Array<{ from: string; text: string; id?: string }> {
  const out: Array<{ from: string; text: string; id?: string }> = [];
  try {
    const root = payload as {
      entry?: Array<{
        changes?: Array<{ value?: WebhookValue }>;
      }>;
    };
    for (const entry of root?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        for (const msg of change?.value?.messages ?? []) {
          if (msg?.type === "text" && msg.from && msg.text?.body) {
            out.push({ from: msg.from, text: msg.text.body, id: msg.id });
          }
        }
      }
    }
  } catch {
    // ignore parse errors
  }
  return out;
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

  // Always acknowledge Meta quickly — process engine + send after parse.
  // Soft-fail send errors so webhook stays 200.
  try {
    const texts = extractTextMessages(parsed);
    for (const inbound of texts) {
      const result = handleFrontDeskMessage(inbound.from, inbound.text);
      console.log(
        `[whatsapp-front-desk] waId=${inbound.from} outcome=${result.outcome} step=${result.session.step}`,
      );
      const sendResult = await sendWhatsAppText({
        to: inbound.from,
        body: result.text.replace(/\*\*/g, "*"), // WhatsApp uses single * for bold
      });
      if (!sendResult.ok && sendResult.reason !== "missing_credentials") {
        console.warn(
          `[whatsapp-front-desk] send soft-fail reason=${sendResult.reason}`,
        );
      } else if (!sendResult.ok) {
        console.log(
          "[whatsapp-front-desk] outbound skipped (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID not set)",
        );
      }
    }
  } catch (err) {
    console.warn("[whatsapp-front-desk] engine error (soft)", err);
  }

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
