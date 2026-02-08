import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { startProxy, RingBuffer } from "../dist/index.js";

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

test("/debug/routing-trace requires local proxy auth", async () => {
  const upstream = createServer(async (req, res) => {
    void req;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;

  const proxy = await startProxy({
    port: 0,
    authToken: "LOCAL_TOKEN",
    providers: {
      openai: { apiBase: `http://127.0.0.1:${upstreamPort}` },
    },
  });

  try {
    const rsp = await fetch(`${proxy.baseUrl}/debug/routing-trace`);
    assert.equal(rsp.status, 401);
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("routing trace events include providerId + upstreamUrl", async () => {
  const upstream = createServer(async (req, res) => {
    // Basic OpenAI-style response.
    const body = await readJson(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const upstreamBase = `http://127.0.0.1:${upstreamPort}`;

  const proxy = await startProxy({
    port: 0,
    authToken: "LOCAL_TOKEN",
    providers: {
      openai: { apiBase: upstreamBase },
    },
  });

  try {
    const rsp = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer LOCAL_TOKEN",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
      }),
    });
    assert.equal(rsp.status, 200);

    const traceRsp = await fetch(`${proxy.baseUrl}/debug/routing-trace?n=5`, {
      headers: { authorization: "Bearer LOCAL_TOKEN" },
    });
    assert.equal(traceRsp.status, 200);
    const { events } = await traceRsp.json();
    assert.ok(Array.isArray(events));
    assert.ok(events.length >= 1);

    const last = events[events.length - 1];
    assert.equal(last.providerId, "openai");
    assert.ok(typeof last.upstreamUrl === "string" && last.upstreamUrl.includes(upstreamBase));
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("RingBuffer caps length", () => {
  const rb = new RingBuffer(3);
  rb.push(1);
  rb.push(2);
  rb.push(3);
  rb.push(4);
  rb.push(5);
  assert.equal(rb.length, 3);
  assert.deepEqual(rb.toArray(), [3, 4, 5]);
});
