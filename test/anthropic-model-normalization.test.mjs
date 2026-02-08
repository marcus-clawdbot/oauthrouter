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

async function runCase(inputModel, expectedUpstreamModel) {
  const seen = { model: null };

  const upstream = createServer(async (req, res) => {
    const body = await readJson(req);
    seen.model = body.model ?? null;

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
        model: inputModel,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
      }),
    });

    assert.equal(rsp.status, 200);
    assert.equal(seen.model, expectedUpstreamModel);
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
}

test("anthropic dotted haiku alias is normalized to dashed Anthropic model id", async () => {
  await runCase("anthropic/claude-haiku-4.5", "claude-haiku-4-5");
});

test("anthropic dashed haiku id passes through unchanged", async () => {
  await runCase("anthropic/claude-haiku-4-5", "claude-haiku-4-5");
});

test("anthropic dotted opus alias is normalized to dashed Anthropic model id", async () => {
  await runCase("anthropic/claude-opus-4.5", "claude-opus-4-5");
});

test("anthropic dotted sonnet alias is normalized to dashed Anthropic model id", async () => {
  await runCase("anthropic/claude-sonnet-4.5", "claude-sonnet-4-5");
});
