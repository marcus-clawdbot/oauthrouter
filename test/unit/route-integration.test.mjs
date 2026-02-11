import test from "node:test";
import assert from "node:assert/strict";
import { route, DEFAULT_ROUTING_CONFIG } from "../../dist/index.js";

const modelPricing = new Map();

// ─── route() end-to-end ───

test("routes simple greeting", () => {
  const decision = route("hello", undefined, 4096, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assert.ok(decision.tier);
  assert.ok(decision.model);
  assert.ok(decision.confidence > 0);
  assert.ok(decision.reasoning);
});

test("routes complex code request above SIMPLE", () => {
  // Use a prompt with code keywords (function, async, import) and technical terms (algorithm, optimize, architecture)
  // that's long enough (>200 chars = >50 estimated tokens) to avoid the short-input penalty
  const decision = route(
    "Write an async function that implements an algorithm to optimize the database architecture by parsing " +
      "the schema and generating migration scripts with comprehensive error handling and retry logic across tables",
    undefined,
    8192,
    { config: DEFAULT_ROUTING_CONFIG, modelPricing },
  );
  assert.ok(
    decision.tier !== "SIMPLE",
    `expected above SIMPLE, got ${decision.tier} (reasoning: ${decision.reasoning})`,
  );
});

test("forces COMPLEX for large context", () => {
  // maxTokensForceComplex is 100,000 tokens; estimatedTokens = Math.ceil(fullText.length / 4)
  // Need > 400,000 chars to exceed the threshold
  const longPrompt = "x".repeat(400_001); // fullText ~400,002 chars → ~100,001 estimated tokens > 100K
  const decision = route(longPrompt, undefined, 4096, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assert.equal(decision.tier, "COMPLEX");
  assert.ok(decision.reasoning.includes("tokens"));
});

test("upgrades structured output to minimum tier", () => {
  // System prompt with "json" triggers structured output detection
  const decision = route("return result", "Always respond in json format", 4096, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  // Should be at least MEDIUM (structuredOutputMinTier)
  assert.ok(
    decision.tier !== "SIMPLE",
    `structured output should not be SIMPLE, got ${decision.tier}`,
  );
});

test("decision has expected shape", () => {
  const decision = route("test", undefined, 4096, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assert.equal(typeof decision.tier, "string");
  assert.equal(typeof decision.model, "string");
  assert.equal(typeof decision.confidence, "number");
  assert.equal(typeof decision.reasoning, "string");
  assert.ok(["rules", "llm"].includes(decision.method));
});
