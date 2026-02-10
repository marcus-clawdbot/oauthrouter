import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { __test__proxyRequest as proxyRequest } from "../../dist/index.js";

class MockRes {
  constructor() {
    this.headersSent = false;
    this.statusCode = 0;
    this.headers = {};
    this.bodyChunks = [];
  }
  writeHead(status, headers) {
    this.statusCode = status;
    this.headersSent = true;
    if (headers) {
      for (const [k, v] of Object.entries(headers))
        this.headers[String(k).toLowerCase()] = String(v);
    }
  }
  write(chunk) {
    this.bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  end(chunk) {
    if (chunk !== undefined) this.write(chunk);
    this.ended = true;
  }
  getBodyText() {
    return Buffer.concat(this.bodyChunks).toString("utf-8");
  }
}

function makeReq({ url, method = "POST", headers = {}, jsonBody }) {
  const body = jsonBody !== undefined ? Buffer.from(JSON.stringify(jsonBody)) : Buffer.alloc(0);
  const r = Readable.from(body.length ? [body] : []);
  r.url = url;
  r.method = method;
  r.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return r;
}

test("proxyRequest maps Anthropic /v1/messages response to OpenAI chat.completion", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    // Anthropic upstream path
    if (String(url).includes("/v1/messages")) {
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "OK" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };

  const req = makeReq({
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    jsonBody: {
      model: "anthropic/claude-haiku-4-5",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    },
  });
  const res = new MockRes();

  const trace = {
    ts: Date.now(),
    requestId: "req1",
    path: req.url,
    method: req.method,
    spend: { decision: "allowed" },
  };
  const options = {
    providers: {
      anthropic: { apiBase: "https://api.anthropic.com", authHeader: "Bearer sk-ant-oat01-test" },
    },
  };

  try {
    await proxyRequest(req, res, options, {}, trace, null);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.getBodyText());
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.content, "OK");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("proxyRequest performs provider-aware 429 fallback (Anthropic -> Codex) for chat.completions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/v1/messages")) {
      return new Response(JSON.stringify({ error: { type: "rate_limit", message: "429" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/backend-api/codex/responses")) {
      return new Response(JSON.stringify({ id: "resp_test", output_text: "OK_FROM_CODEX" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };

  const req = makeReq({
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    jsonBody: {
      model: "anthropic/claude-haiku-4-5",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    },
  });
  const res = new MockRes();
  const trace = {
    ts: Date.now(),
    requestId: "req2",
    path: req.url,
    method: req.method,
    spend: { decision: "allowed" },
  };

  const options = {
    providers: {
      anthropic: { apiBase: "https://api.anthropic.com", authHeader: "Bearer sk-ant-oat01-test" },
      "openai-codex": {
        apiBase: "https://chatgpt.com",
        authHeader: "Bearer test.jwt.token",
        headers: { "chatgpt-account-id": "acct_test" },
      },
    },
    rateLimitFallback: {
      enabled: true,
      fromProviders: ["anthropic"],
      onStatusCodes: [429],
      chain: [{ provider: "openai-codex", defaultModel: "openai-codex/gpt-5.2" }],
    },
  };

  try {
    await proxyRequest(req, res, options, {}, trace, null);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.getBodyText());
    assert.equal(body.choices[0].message.content, "OK_FROM_CODEX");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
