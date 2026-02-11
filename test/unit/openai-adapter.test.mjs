import test from "node:test";
import assert from "node:assert/strict";
import { toOpenAiModelId, normalizeOpenAiChatCompletionsRequest } from "../../dist/index.js";

// ─── toOpenAiModelId ───

test("strips openai/ prefix", () => {
  assert.equal(toOpenAiModelId("openai/gpt-4o"), "gpt-4o");
});

test("passes through non-prefixed model", () => {
  assert.equal(toOpenAiModelId("gpt-4o"), "gpt-4o");
});

// ─── normalizeOpenAiChatCompletionsRequest ───

test("normalizes model ID in request", () => {
  const req = normalizeOpenAiChatCompletionsRequest({
    model: "openai/gpt-4o",
    messages: [{ role: "user", content: "Hi" }],
  });
  assert.equal(req.model, "gpt-4o");
});

test("preserves other fields", () => {
  const req = normalizeOpenAiChatCompletionsRequest({
    model: "openai/gpt-4o",
    messages: [{ role: "user", content: "Hi" }],
    temperature: 0.5,
    max_tokens: 100,
  });
  assert.equal(req.temperature, 0.5);
  assert.equal(req.max_tokens, 100);
});

test("returns request unchanged when model is empty", () => {
  const original = { model: "", messages: [] };
  const req = normalizeOpenAiChatCompletionsRequest(original);
  assert.equal(req, original);
});
