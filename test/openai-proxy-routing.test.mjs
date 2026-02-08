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

test("routes openai/* models to OpenAI upstream and strips local auth", async () => {
  const seen = { auth: null, path: null, model: null };

  const upstream = createServer(async (req, res) => {
    seen.path = req.url;
    seen.auth = req.headers.authorization ?? null;
    const body = await readJson(req);
    seen.model = body.model;

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
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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
      openai: {
        apiBase: upstreamBase,
        authHeader: { name: "Authorization", value: "Bearer OPENAI_TOKEN" },
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
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
      }),
    });

    assert.equal(rsp.status, 200);
    const json = await rsp.json();
    assert.equal(json.choices?.[0]?.message?.content, "ok");

    assert.equal(seen.path, "/v1/chat/completions");
    assert.equal(seen.auth, "Bearer OPENAI_TOKEN");
    assert.equal(seen.model, "gpt-4o-mini");
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("oauthrouter/auto routes to an OpenAI model (smoke)", async () => {
  const seen = { model: null };

  const upstream = createServer(async (req, res) => {
    const body = await readJson(req);
    seen.model = body.model;

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          { index: 0, message: { role: "assistant", content: "auto-ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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
      openai: {
        apiBase: upstreamBase,
        authHeader: { name: "Authorization", value: "Bearer OPENAI_TOKEN" },
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
        model: "oauthrouter/auto",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 8,
      }),
    });

    assert.equal(rsp.status, 200);
    const json = await rsp.json();
    assert.equal(json.choices?.[0]?.message?.content, "auto-ok");

    // Default auto config selects openai/gpt-4o-mini for SIMPLE.
    assert.equal(seen.model, "gpt-4o-mini");
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
