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

function anthropicOkResponse(model) {
  return {
    id: "msg_test",
    model,
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

test("anthropic oauth token (sk-ant-oat...) is sent via Authorization + claude-code headers", async () => {
  const seen = {
    path: null,
    authorization: null,
    xApiKey: null,
    anthropicBeta: null,
    xApp: null,
    userAgent: null,
    dangerous: null,
  };

  const upstream = createServer(async (req, res) => {
    seen.path = req.url;
    seen.authorization = req.headers.authorization ?? null;
    seen.xApiKey = req.headers["x-api-key"] ?? null;
    seen.anthropicBeta = req.headers["anthropic-beta"] ?? null;
    seen.xApp = req.headers["x-app"] ?? null;
    seen.userAgent = req.headers["user-agent"] ?? null;
    seen.dangerous = req.headers["anthropic-dangerous-direct-browser-access"] ?? null;

    // Ensure adapter is active.
    const body = await readJson(req);

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(anthropicOkResponse(body.model)));
  });

  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const upstreamBase = `http://127.0.0.1:${upstreamPort}`;

  const proxy = await startProxy({
    port: 0,
    authToken: "LOCAL_TOKEN",
    providers: {
      anthropic: {
        apiBase: upstreamBase,
        authHeader: { name: "x-api-key", value: "sk-ant-oat-testtoken" },
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
        model: "anthropic/claude-sonnet-4",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
      }),
    });

    assert.equal(rsp.status, 200);
    const json = await rsp.json();
    assert.equal(json.choices?.[0]?.message?.content, "ok");

    assert.equal(seen.path, "/v1/messages");
    assert.equal(seen.authorization, "Bearer sk-ant-oat-testtoken");
    assert.equal(seen.xApiKey, null);

    assert.ok(String(seen.anthropicBeta).includes("claude-code-20250219"));
    assert.ok(String(seen.anthropicBeta).includes("oauth-2025-04-20"));

    assert.equal(seen.xApp, "cli");
    assert.ok(String(seen.userAgent).startsWith("claude-cli/"));
    assert.equal(seen.dangerous, "true");
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("anthropic api key token uses x-api-key (no oauth header mode)", async () => {
  const seen = { authorization: null, xApiKey: null };

  const upstream = createServer(async (req, res) => {
    seen.authorization = req.headers.authorization ?? null;
    seen.xApiKey = req.headers["x-api-key"] ?? null;

    const body = await readJson(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(anthropicOkResponse(body.model)));
  });

  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const upstreamBase = `http://127.0.0.1:${upstreamPort}`;

  const proxy = await startProxy({
    port: 0,
    authToken: "LOCAL_TOKEN",
    providers: {
      anthropic: {
        apiBase: upstreamBase,
        authHeader: { name: "x-api-key", value: "sk-ant-api-key-test" },
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
        model: "anthropic/claude-sonnet-4",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
      }),
    });

    assert.equal(rsp.status, 200);
    const json = await rsp.json();
    assert.equal(json.choices?.[0]?.message?.content, "ok");

    assert.equal(seen.xApiKey, "sk-ant-api-key-test");
    assert.equal(seen.authorization, null);
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
