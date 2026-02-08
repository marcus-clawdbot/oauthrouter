import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getOpenAICodexAuthHeader } from "../dist/index.js";

test("refreshes openai-codex oauth access token under lock and persists updated fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oauthrouter-"));
  const authStorePath = join(dir, "auth-profiles.json");

  const nowMs = 1_700_000_000_000;

  writeFileSync(
    authStorePath,
    JSON.stringify(
      {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "old_access",
            refresh: "r1",
            expiresAt: nowMs - 10_000,
          },
        },
        lastGood: { "openai-codex": "openai-codex:default" },
      },
      null,
      2,
    ),
    "utf-8",
  );

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });

    assert.equal(url, "https://auth.openai.com/oauth/token");
    assert.equal(init.method, "POST");

    const body = init.body;
    assert.ok(body instanceof URLSearchParams);
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "r1");
    assert.equal(body.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");

    return new Response(
      JSON.stringify({
        access_token: "new_access",
        refresh_token: "r2",
        expires_in: 3600,
        token_type: "Bearer",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const result = await getOpenAICodexAuthHeader({ authStorePath, fetchImpl, nowMs });

  assert.deepEqual(result, {
    Authorization: "Bearer new_access",
    profileId: "openai-codex:default",
    refreshed: true,
  });

  assert.equal(calls.length, 1);

  const saved = JSON.parse(readFileSync(authStorePath, "utf-8"));
  assert.equal(saved.profiles["openai-codex:default"].access, "new_access");
  assert.equal(saved.profiles["openai-codex:default"].refresh, "r2");
  assert.equal(saved.profiles["openai-codex:default"].expiresAt, nowMs + 3600 * 1000);
});

test("does not refresh openai-codex token when expiresAt is sufficiently in the future", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oauthrouter-"));
  const authStorePath = join(dir, "auth-profiles.json");

  const nowMs = 1_700_000_000_000;

  writeFileSync(
    authStorePath,
    JSON.stringify(
      {
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "still_valid",
            refresh: "r1",
            expiresAt: nowMs + 10 * 60_000,
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  const fetchImpl = async () => {
    throw new Error("fetch should not be called");
  };

  const result = await getOpenAICodexAuthHeader({ authStorePath, fetchImpl, nowMs });
  assert.deepEqual(result, {
    Authorization: "Bearer still_valid",
    profileId: "openai-codex:default",
    refreshed: false,
  });
});
