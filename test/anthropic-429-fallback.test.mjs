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

test("anthropic 429 triggers provider-aware fallback and returns fallback response", async () => {
  const seen = {
    anthropic: { hits: 0, path: null },
    deepseek: { hits: 0, path: null, auth: null, model: null },
  };

  // Fake Anthropic upstream: always 429 on /v1/messages.
  const anthropicUpstream = createServer(async (req, res) => {
    seen.anthropic.hits++;
    seen.anthropic.path = req.url;
    await readJson(req).catch(() => null);
    res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
    res.end(JSON.stringify({ error: { message: "rate_limited" } }));
  });

  // Fake DeepSeek upstream: standard OpenAI chat.completions response.
  const deepseekUpstream = createServer(async (req, res) => {
    seen.deepseek.hits++;
    seen.deepseek.path = req.url;
    seen.deepseek.auth = req.headers.authorization ?? null;
    const body = await readJson(req);
    seen.deepseek.model = body.model;

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "fallback-ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });

  await new Promise((resolve) => anthropicUpstream.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => deepseekUpstream.listen(0, "127.0.0.1", resolve));

  const aPort = anthropicUpstream.address().port;
  const dPort = deepseekUpstream.address().port;
  const aBase = `http://127.0.0.1:${aPort}`;
  const dBase = `http://127.0.0.1:${dPort}`;

  const proxy = await startProxy({
    port: 0,
    authToken: "LOCAL_TOKEN",
    providers: {
      anthropic: {
        apiBase: aBase,
        authHeader: { name: "x-api-key", value: "ANTHROPIC_TOKEN" },
      },
      deepseek: {
        apiBase: dBase,
        authHeader: { name: "Authorization", value: "Bearer DEEPSEEK_TOKEN" },
      },
    },
    rateLimitFallback: {
      enabled: true,
      toProvider: "deepseek",
      defaultModel: "deepseek/deepseek-chat",
    },
  });

  try {
    const rsp = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer LOCAL_TOKEN" },
      body: JSON.stringify({
        model: "anthropic/claude-haiku-4-5",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
      }),
    });

    assert.equal(rsp.status, 200);
    const json = await rsp.json();
    assert.equal(json.choices?.[0]?.message?.content, "fallback-ok");

    assert.equal(seen.anthropic.hits, 1);
    assert.equal(seen.anthropic.path, "/v1/messages");

    assert.equal(seen.deepseek.hits, 1);
    assert.equal(seen.deepseek.path, "/v1/chat/completions");
    assert.equal(seen.deepseek.auth, "Bearer DEEPSEEK_TOKEN");
    // DeepSeek adapter should strip "deepseek/" prefix.
    assert.equal(seen.deepseek.model, "deepseek-chat");
  } finally {
    await proxy.close();
    await new Promise((resolve) => anthropicUpstream.close(resolve));
    await new Promise((resolve) => deepseekUpstream.close(resolve));
  }
});
