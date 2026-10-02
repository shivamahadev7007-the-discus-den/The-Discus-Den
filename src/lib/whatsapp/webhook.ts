import { createHmac, timingSafeEqual } from "node:crypto";
import { ingestInboundText, type FrontDeskReply } from "./front-desk.ts";
import { sendWhatsAppText, type SendTextResult } from "./send.ts";

/**
 * WhatsApp Cloud API webhook logic (used by src/routes/api/whatsapp.ts).
 * GET  - Meta hub challenge verification
 * POST - signature check, ACK 200 {ok:true}; FE-2 front-desk replies ONLY when
 *        WHATSAPP_FRONT_DESK_ENABLED === "true" (kill switch, default off).
 *
 * Env (Vercel; never commit):
 *   WHATSAPP_VERIFY_TOKEN
 *   WHATSAPP_APP_SECRET (optional; X-Hub-Signature-256)
 *   WHATSAPP_FRONT_DESK_ENABLED ("true" to enable replies; anything else = off)
 *   WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID (outbound; used only when enabled)
 */

export type WebhookEnv = Record<string, string | undefined>;

export type WebhookDeps = {
  env?: WebhookEnv;
  ingest?: (
    waId: string,
    text: string,
    opts: { coalesceMs?: number; onReply: (reply: FrontDeskReply) => void | Promise<void> },
  ) => unknown;
  send?: (options: { to: string; body: string }) => Promise<SendTextResult>;
  /** Test hook: burst coalesce window passed through to ingest. */
  coalesceMs?: number;
};

export function isFrontDeskEnabled(env: WebhookEnv = process.env): boolean {
  return env.WHATSAPP_FRONT_DESK_ENABLED === "true";
}

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

export async function handleWebhookGet(request: Request, env: WebhookEnv = process.env): Promise<Response> {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const verifyToken = env.WHATSAPP_VERIFY_TOKEN;

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

export async function handleWebhookPost(
  request: Request,
  deps: WebhookDeps = {},
): Promise<Response> {
  const env = deps.env ?? process.env;
  const appSecret = env.WHATSAPP_APP_SECRET;

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (err) {
    console.error("[whatsapp-webhook] body read failed", err);
    // Still 200 so Meta does not disable the webhook for transient errors.
    return Response.json({ ok: true });
  }

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

  if (!isFrontDeskEnabled(env)) {
    console.log(
      "[whatsapp-webhook] front desk disabled (WHATSAPP_FRONT_DESK_ENABLED != \"true\"); ack only, no reply",
    );
    return Response.json({ ok: true });
  }

  const ingest = deps.ingest ?? ingestInboundText;
  const send = deps.send ?? sendWhatsAppText;

  // Always acknowledge Meta quickly; soft-fail engine/send errors so webhook stays 200.
  try {
    const texts = extractTextMessages(parsed);
    // Burst coalesce (~8-15s / BURST_COALESCE_MS): buffer same waId, one reply on flush.
    for (const inbound of texts) {
      void ingest(inbound.from, inbound.text, {
        ...(deps.coalesceMs !== undefined ? { coalesceMs: deps.coalesceMs } : {}),
        onReply: async (result) => {
          console.log(
            `[whatsapp-front-desk] waId=${inbound.from} outcome=${result.outcome} step=${result.session.step}`,
          );
          try {
            const sendResult = await send({
              to: inbound.from,
              body: result.text.replace(/\*\*/g, "*"), // WhatsApp uses single * for bold
            });
            if (!sendResult.ok && sendResult.reason !== "missing_credentials") {
              console.warn(`[whatsapp-front-desk] send soft-fail reason=${sendResult.reason}`);
            } else if (!sendResult.ok) {
              console.log(
                "[whatsapp-front-desk] outbound skipped (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID not set)",
              );
            }
          } catch (sendErr) {
            console.warn("[whatsapp-front-desk] send error (soft)", sendErr);
          }
        },
      });
    }
  } catch (err) {
    console.warn("[whatsapp-front-desk] engine error (soft)", err);
  }

  return Response.json({ ok: true });
}
