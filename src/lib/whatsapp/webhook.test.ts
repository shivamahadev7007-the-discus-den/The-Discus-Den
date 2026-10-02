import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { resetSessions, resetBursts } from "./front-desk.ts";
import { handleWebhookGet, handleWebhookPost, isFrontDeskEnabled } from "./webhook.ts";

const URL_BASE = "https://example.test/api/whatsapp";
const WA_ID = "test-wa-id-a";

function inboundPayload(text: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: { messages: [{ from: WA_ID, type: "text", id: "wamid.test", text: { body: text } }] },
          },
        ],
      },
    ],
  };
}

function post(body: string, headers: Record<string, string> = {}) {
  return new Request(URL_BASE, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function sendSpy() {
  const calls: Array<{ to: string; body: string }> = [];
  return {
    calls,
    send: async (o: { to: string; body: string }) => {
      calls.push(o);
      return { ok: true as const };
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  resetSessions();
  resetBursts();
});

describe("WhatsApp webhook kill switch (WHATSAPP_FRONT_DESK_ENABLED)", () => {
  it("only exactly \"true\" enables the front desk", () => {
    assert.equal(isFrontDeskEnabled({}), false);
    assert.equal(isFrontDeskEnabled({ WHATSAPP_FRONT_DESK_ENABLED: "1" }), false);
    assert.equal(isFrontDeskEnabled({ WHATSAPP_FRONT_DESK_ENABLED: "TRUE" }), false);
    assert.equal(isFrontDeskEnabled({ WHATSAPP_FRONT_DESK_ENABLED: "true" }), true);
  });

  it("off (unset): POST acks 200 {ok:true}, no ingest, no send, even with Graph creds set", async () => {
    const spy = sendSpy();
    let ingested = 0;
    const res = await handleWebhookPost(post(JSON.stringify(inboundPayload("hi"))), {
      env: { WHATSAPP_ACCESS_TOKEN: "tok", WHATSAPP_PHONE_NUMBER_ID: "pnid" },
      send: spy.send,
      ingest: () => {
        ingested++;
      },
      coalesceMs: 0,
    });
    await tick();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(ingested, 0);
    assert.equal(spy.calls.length, 0);
  });

  it("off: signature check still runs (bad signature -> 403, no send)", async () => {
    const spy = sendSpy();
    const res = await handleWebhookPost(
      post(JSON.stringify(inboundPayload("hi")), { "x-hub-signature-256": "sha256=deadbeef" }),
      { env: { WHATSAPP_APP_SECRET: "secret" }, send: spy.send, coalesceMs: 0 },
    );
    assert.equal(res.status, 403);
    assert.equal(spy.calls.length, 0);
  });

  it("off: valid signature -> 200 {ok:true}, no send", async () => {
    const spy = sendSpy();
    const body = JSON.stringify(inboundPayload("hi"));
    const sig = "sha256=" + createHmac("sha256", "secret").update(body).digest("hex");
    const res = await handleWebhookPost(post(body, { "x-hub-signature-256": sig }), {
      env: { WHATSAPP_APP_SECRET: "secret" },
      send: spy.send,
      coalesceMs: 0,
    });
    await tick();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(spy.calls.length, 0);
  });

  it("on (\"true\"): front desk replies and send is called once per message", async () => {
    const spy = sendSpy();
    const res = await handleWebhookPost(post(JSON.stringify(inboundPayload("hi"))), {
      env: { WHATSAPP_FRONT_DESK_ENABLED: "true" },
      send: spy.send,
      coalesceMs: 0,
    });
    await tick();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].to, WA_ID);
    assert.ok(spy.calls[0].body.length > 0);
    assert.ok(!spy.calls[0].body.includes("**"));
  });

  it("body read failure -> 200 {ok:true} (like the legacy handler)", async () => {
    const spy = sendSpy();
    const broken = {
      headers: new Headers(),
      text: () => Promise.reject(new Error("boom")),
    } as unknown as Request;
    const res = await handleWebhookPost(broken, {
      env: { WHATSAPP_FRONT_DESK_ENABLED: "true" },
      send: spy.send,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(spy.calls.length, 0);
  });

  it("GET verify: right token echoes challenge, wrong token 403", async () => {
    const env = { WHATSAPP_VERIFY_TOKEN: "vt" };
    const ok = await handleWebhookGet(
      new Request(`${URL_BASE}?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=12345`),
      env,
    );
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "12345");
    const bad = await handleWebhookGet(
      new Request(`${URL_BASE}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345`),
      env,
    );
    assert.equal(bad.status, 403);
  });
});
