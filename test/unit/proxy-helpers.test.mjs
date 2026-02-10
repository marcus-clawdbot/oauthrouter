import test from "node:test";
import assert from "node:assert/strict";

import {
  __test__canonicalModelForTier as canonicalModelForTier,
  __test__parseBearerToken as parseBearerToken,
  __test__ensureCommaSeparatedIncludes as ensureCommaSeparatedIncludes,
  __test__normalizeAnthropicUpstreamAuthHeaders as normalizeAnthropicUpstreamAuthHeaders,
  __test__estimateInputTokensFromBody as estimateInputTokensFromBody,
  __test__shouldTriggerRateLimitFallback as shouldTriggerRateLimitFallback,
  __test__getRateLimitFallbackChain as getRateLimitFallbackChain,
  __test__resolveFallbackModelId as resolveFallbackModelId,
} from "../../dist/index.js";

test("parseBearerToken accepts Bearer and raw tokens", () => {
  assert.equal(parseBearerToken(undefined), null);
  assert.equal(parseBearerToken(""), null);
  assert.equal(parseBearerToken("Bearer abc"), "abc");
  assert.equal(parseBearerToken("bearer   abc  "), "abc");
  assert.equal(parseBearerToken("abc"), "abc");
});

test("ensureCommaSeparatedIncludes adds required values without losing existing", () => {
  const out = ensureCommaSeparatedIncludes("a, b", ["b", "c"]);
  const set = new Set(
    out
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  assert.equal(set.has("a"), true);
  assert.equal(set.has("b"), true);
  assert.equal(set.has("c"), true);
});

test("normalizeAnthropicUpstreamAuthHeaders switches to OAuth header mode for sk-ant-oat tokens", () => {
  const headers = {
    "x-api-key": "sk-ant-oat01-xyz",
  };
  normalizeAnthropicUpstreamAuthHeaders(headers);
  assert.equal(headers["x-api-key"], undefined);
  assert.equal(headers.authorization.startsWith("Bearer "), true);
  assert.ok(String(headers["anthropic-beta"]).includes("claude-code-"));
  assert.equal(headers["anthropic-dangerous-direct-browser-access"], "true");
});

test("normalizeAnthropicUpstreamAuthHeaders prefers x-api-key for non-oauth tokens", () => {
  const headers = {
    authorization: "sk-ant-api-key",
  };
  normalizeAnthropicUpstreamAuthHeaders(headers);
  assert.equal(headers.authorization, undefined);
  assert.equal(headers["x-api-key"], "sk-ant-api-key");
});

test("estimateInputTokensFromBody uses message content when available", () => {
  const body = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "abcd" }] }));
  const parsed = { messages: [{ role: "user", content: "abcd" }] };
  assert.equal(estimateInputTokensFromBody(body, parsed), 1); // 4 chars -> ~1 token
});

test("canonicalModelForTier returns known ids for providers", () => {
  assert.equal(canonicalModelForTier("anthropic", "SIMPLE"), "anthropic/claude-haiku-4-5");
  assert.equal(canonicalModelForTier("openai-codex", "SIMPLE"), "openai-codex/gpt-5.1-codex-mini");
  assert.equal(canonicalModelForTier("deepseek", "COMPLEX"), "deepseek/deepseek-reasoner");
});

test("rate-limit fallback trigger logic is provider-scoped and code-scoped", () => {
  const cfg = { enabled: true, fromProviders: ["anthropic"], onStatusCodes: [429] };
  assert.equal(shouldTriggerRateLimitFallback(cfg, "anthropic", 429), true);
  assert.equal(shouldTriggerRateLimitFallback(cfg, "anthropic", 500), false);
  assert.equal(shouldTriggerRateLimitFallback(cfg, "openai-codex", 429), false);
});

test("rate-limit fallback chain resolves model map and defaults", () => {
  const cfg = {
    enabled: true,
    chain: [
      {
        provider: "openai-codex",
        modelMap: { "anthropic/claude-haiku-4-5": "openai-codex/gpt-5.2" },
      },
    ],
  };
  const chain = getRateLimitFallbackChain(cfg);
  assert.equal(chain.length, 1);
  const m = resolveFallbackModelId(
    chain[0].modelMap,
    chain[0].defaultModel,
    "anthropic/claude-haiku-4-5",
  );
  assert.equal(m, "openai-codex/gpt-5.2");
});
