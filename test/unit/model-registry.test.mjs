import test from "node:test";
import assert from "node:assert/strict";
import { resolveProviderForModelId, isAutoModelId } from "../../dist/index.js";

// ─── resolveProviderForModelId ───

test("resolves anthropic/ prefix", () => {
  assert.equal(resolveProviderForModelId("anthropic/claude-sonnet-4-5"), "anthropic");
});

test("resolves openai/ prefix", () => {
  assert.equal(resolveProviderForModelId("openai/gpt-4o"), "openai");
});

test("resolves openai-codex/ prefix", () => {
  assert.equal(resolveProviderForModelId("openai-codex/gpt-5.2-codex"), "openai-codex");
});

test("resolves deepseek/ prefix", () => {
  assert.equal(resolveProviderForModelId("deepseek/deepseek-chat"), "deepseek");
});

test("returns null for unknown prefix", () => {
  assert.equal(resolveProviderForModelId("google/gemini-2"), null);
});

test("returns null for unprefixed model", () => {
  assert.equal(resolveProviderForModelId("claude-sonnet-4-5"), null);
});

test("handles whitespace", () => {
  assert.equal(resolveProviderForModelId("  anthropic/claude-haiku-4-5  "), "anthropic");
});

// ─── isAutoModelId ───

test("recognizes oauthrouter/auto", () => {
  assert.equal(isAutoModelId("oauthrouter/auto"), true);
});

test("recognizes bare auto", () => {
  assert.equal(isAutoModelId("auto"), true);
});

test("rejects non-auto model", () => {
  assert.equal(isAutoModelId("anthropic/claude-sonnet-4-5"), false);
});

test("handles whitespace in auto", () => {
  assert.equal(isAutoModelId("  auto  "), true);
});
