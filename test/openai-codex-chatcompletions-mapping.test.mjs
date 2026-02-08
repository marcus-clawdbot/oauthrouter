import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { startProxy } from "../dist/index.js";

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

test("openai-codex stream=true maps Responses SSE -> OpenAI chat.completions SSE", async () => {
  const upstream = createServer(async (req, res) => {
    // Ensure we got a Responses-style request.
    const body = await readJson(req);
    assert.equal(req.url, "/backend-api/codex/responses");
    assert.equal(body.store, false);

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });

    const events = [
      { type: "response.created", response: { id: "resp_test" } },
      { type: "response.output_text.delta", delta: "OK" },
      { type: "response.completed", response: { id: "resp_test" } },
    ];

    for (const e of events) {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });

  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const upstreamBase = `http://127.0.0.1:${upstreamPort}`;

  const proxy = await startProxy({
    port: 0,
    authToken: "LOCAL_TOKEN",
    providers: {
      "openai-codex": {
        apiBase: upstreamBase,
        // Avoid touching real OpenClaw auth store in tests
        authHeader: "Bearer test.jwt.token",
        headers: { "chatgpt-account-id": "acct_test" },
      },
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
        model: "openai-codex/gpt-5.3-codex",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    assert.equal(rsp.status, 200);
    const text = await rsp.text();

    // Should be OpenAI-style SSE chunks.
    assert.ok(text.includes("chat.completion.chunk"));
    assert.ok(text.includes('"content":"OK"'));
    assert.ok(text.includes("data: [DONE]"));
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("openai-codex stream=false maps Responses JSON -> OpenAI chat.completion JSON", async () => {
  const upstream = createServer(async (req, res) => {
    const body = await readJson(req);
    assert.equal(req.url, "/backend-api/codex/responses");
    assert.equal(body.store, false);

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "resp_test", output_text: "OK" }));
  });

  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const upstreamBase = `http://127.0.0.1:${upstreamPort}`;

  const proxy = await startProxy({
    port: 0,
    authToken: "LOCAL_TOKEN",
    providers: {
      "openai-codex": {
        apiBase: upstreamBase,
        authHeader: "Bearer test.jwt.token",
        headers: { "chatgpt-account-id": "acct_test" },
      },
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
        model: "openai-codex/gpt-5.3-codex",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    assert.equal(rsp.status, 200);
    const json = await rsp.json();
    assert.equal(json.object, "chat.completion");
    assert.equal(json.choices?.[0]?.message?.content, "OK");
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
