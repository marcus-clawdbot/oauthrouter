import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalModelForProviderTier,
  ANTHROPIC_TO_CODEX_FALLBACK_MODEL_MAP,
  ANTHROPIC_TO_DEEPSEEK_FALLBACK_MODEL_MAP,
  buildDefaultRateLimitFallbackChain,
} from "../../dist/index.js";

// ─── canonicalModelForProviderTier ───

test("returns Anthropic model for SIMPLE tier", () => {
  const model = canonicalModelForProviderTier("anthropic", "SIMPLE");
  assert.ok(model, "should return a model");
  assert.ok(model.includes("claude"), "should be a Claude model");
});

test("returns Codex model for MEDIUM tier", () => {
  const model = canonicalModelForProviderTier("openai-codex", "MEDIUM");
  assert.ok(model, "should return a model");
});

test("returns null for unknown provider", () => {
  const model = canonicalModelForProviderTier("google", "SIMPLE");
  assert.equal(model, null);
});

// ─── Fallback model maps ───

test("Anthropic to Codex fallback map has entries", () => {
  assert.ok(Object.keys(ANTHROPIC_TO_CODEX_FALLBACK_MODEL_MAP).length > 0);
});

test("Anthropic to DeepSeek fallback map has entries", () => {
  assert.ok(Object.keys(ANTHROPIC_TO_DEEPSEEK_FALLBACK_MODEL_MAP).length > 0);
});

// ─── buildDefaultRateLimitFallbackChain ───

test("builds chain with DeepSeek when available", () => {
  const chain = buildDefaultRateLimitFallbackChain(true);
  assert.ok(chain.length > 0);
  const providers = chain.map((c) => c.provider);
  assert.ok(providers.includes("openai-codex"));
  assert.ok(providers.includes("deepseek"));
});

test("builds chain without DeepSeek", () => {
  const chain = buildDefaultRateLimitFallbackChain(false);
  const providers = chain.map((c) => c.provider);
  assert.ok(!providers.includes("deepseek"));
});
