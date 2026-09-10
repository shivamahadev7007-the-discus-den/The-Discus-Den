import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * WhatsApp Cloud API webhook (Vercel serverless).
 * GET  — Meta hub challenge verification
 * POST — accept inbound notifications; respond 200 quickly (no bot replies)
 *
 * Env (set in Vercel; never commit secrets):
 *   WHATSAPP_VERIFY_TOKEN  — required for GET verify
 *   WHATSAPP_APP_SECRET    — optional; enables X-Hub-Signature-256 checks on POST
 */

type VercelRequest = IncomingMessage & {
  method?: string;
  query: Record<string, string | string[] | undefined>;
  body?: unknown;
};

type VercelResponse = ServerResponse & {
  status: (code: number) => VercelResponse;
  send: (body: string) => void;
  json: (body: unknown) => void;
};

function firstQuery(
  query: VercelRequest["query"],
  key: string,
): string | undefined {
  const v = query[key];
  if (Array.isArray(v)) return v[0];
  return v;
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
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
        id?: string;
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
    const entry = root?.entry?.[0];
    const change = entry?.changes?.[0];
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

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const method = (req.method ?? "GET").toUpperCase();

  if (method === "GET") {
    const mode = firstQuery(req.query, "hub.mode");
    const token = firstQuery(req.query, "hub.verify_token");
    const challenge = firstQuery(req.query, "hub.challenge");
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

    if (
      mode === "subscribe" &&
      verifyToken &&
      token === verifyToken &&
      typeof challenge === "string" &&
      challenge.length > 0
    ) {
      res.status(200).send(challenge);
      return;
    }
    res.status(403).send("Forbidden");
    return;
  }

  if (method === "POST") {
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    let raw: Buffer;
    try {
      raw = await readRawBody(req);
    } catch (err) {
      console.error("[whatsapp-webhook] body read failed", err);
      // Still 200 so Meta does not disable the webhook for transient errors.
      res.status(200).json({ ok: true });
      return;
    }

    if (appSecret) {
      const sig =
        typeof req.headers["x-hub-signature-256"] === "string"
          ? req.headers["x-hub-signature-256"]
          : undefined;
      if (!verifySignature(raw, sig, appSecret)) {
        console.warn("[whatsapp-webhook] invalid X-Hub-Signature-256");
        res.status(403).send("Forbidden");
        return;
      }
    }

    let parsed: unknown = req.body;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        parsed = req.body;
      }
    }

    console.log(`[whatsapp-webhook] ${summarizeInbound(parsed)}`);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).send("Method Not Allowed");
}
