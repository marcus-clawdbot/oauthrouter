import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf-8").toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  return `${header}.${body}.`;
}

test("routes openai-codex/* models to /backend-api/codex/responses and sets required headers", async () => {
  const claimKey = "https://api.openai.com/auth.chatgpt_account_id";
  const jwt = makeJwt({ [claimKey]: "acct_test_123" });

  const seen = {
    path: null,
    auth: null,
    acct: null,
    beta: null,
    originator: null,
    accept: null,
    userAgent: null,
    model: null,
  };

  const upstream = createServer(async (req, res) => {
    seen.path = req.url;
    seen.auth = req.headers.authorization ?? null;
    seen.acct = req.headers["chatgpt-account-id"] ?? null;
    seen.beta = req.headers["openai-beta"] ?? null;
    seen.originator = req.headers.originator ?? null;
    seen.accept = req.headers.accept ?? null;
    seen.userAgent = req.headers["user-agent"] ?? null;

    const body = await readJson(req);
    seen.model = body.model;

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "resp_test_1", output_text: "ok" }));
  });

  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const upstreamBase = `http://127.0.0.1:${upstreamPort}`;

  const dir = mkdtempSync(join(tmpdir(), "oauthrouter-codex-"));
  const authStorePath = join(dir, "auth-profiles.json");
  writeFileSync(
    authStorePath,
    JSON.stringify(
      {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: jwt,
            refresh: "r1",
            expiresAt: Date.now() + 3600_000,
          },
        },
        order: { "openai-codex": ["openai-codex:default"] },
        lastGood: { "openai-codex": "openai-codex:default" },
      },
      null,
      2,
    ),
    "utf-8",
  );

  const proxy = await startProxy({
    port: 0,
    authToken: "LOCAL_TOKEN",
    authStorePath,
    providers: {
      "openai-codex": {
        apiBase: upstreamBase,
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
        model: "openai-codex/gpt-5.2-codex",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
      }),
    });

    assert.equal(rsp.status, 200);
    const json = await rsp.json();
    assert.equal(json.object, "chat.completion");
    assert.equal(json.choices?.[0]?.message?.content, "ok");

    assert.equal(seen.path, "/backend-api/codex/responses");
    assert.equal(seen.model, "gpt-5.2-codex");
    assert.equal(seen.auth, `Bearer ${jwt}`);
    assert.equal(seen.acct, "acct_test_123");
    assert.equal(seen.beta, "responses=experimental");
    assert.equal(seen.originator, "pi");
    assert.equal(seen.accept, "text/event-stream");
    assert.ok(typeof seen.userAgent === "string" && seen.userAgent.startsWith("pi("));
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
