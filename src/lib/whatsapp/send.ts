/**
 * WhatsApp Cloud API outbound text helper.
 * Soft-fails on errors (log only). Never throws to webhook caller.
 */

export type SendTextResult =
  | { ok: true; messageId?: string }
  | { ok: false; reason: string };

export async function sendWhatsAppText(options: {
  to: string;
  body: string;
  accessToken?: string;
  phoneNumberId?: string;
  fetchImpl?: typeof fetch;
}): Promise<SendTextResult> {
  const token = options.accessToken ?? process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId =
    options.phoneNumberId ?? process.env.WHATSAPP_PHONE_NUMBER_ID;
  const fetchFn = options.fetchImpl ?? fetch;

  if (!token || !phoneNumberId) {
    return { ok: false, reason: "missing_credentials" };
  }

  const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}/messages`;

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: options.to,
        type: "text",
        text: { preview_url: false, body: options.body },
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn(
        `[whatsapp-send] Graph API ${res.status}: ${errText.slice(0, 200)}`,
      );
      return { ok: false, reason: `http_${res.status}` };
    }

    const data = (await res.json().catch(() => null)) as {
      messages?: Array<{ id?: string }>;
    } | null;
    return { ok: true, messageId: data?.messages?.[0]?.id };
  } catch (err) {
    console.warn("[whatsapp-send] failed", err);
    return { ok: false, reason: "network_error" };
  }
}
