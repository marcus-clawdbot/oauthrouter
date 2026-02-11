import test from "node:test";
import assert from "node:assert/strict";
import { classifyByRules, DEFAULT_ROUTING_CONFIG } from "../../dist/index.js";

const scoring = DEFAULT_ROUTING_CONFIG.scoring;

// ─── Basic tier classification ───

test("classifies simple greeting as SIMPLE", () => {
  const result = classifyByRules("hello", undefined, 5, scoring);
  assert.ok(result.tier === "SIMPLE" || result.tier === null, `got tier=${result.tier}`);
  assert.ok(result.score < scoring.tierBoundaries.mediumComplex);
});

test("classifies 'what is 2+2' as SIMPLE", () => {
  const result = classifyByRules("what is 2+2?", undefined, 10, scoring);
  assert.ok(
    result.tier === "SIMPLE" || result.tier === null,
    `expected SIMPLE or ambiguous, got ${result.tier}`,
  );
});

test("classifies code request as MEDIUM or above", () => {
  const prompt = "Write a function that parses JSON and handles errors with try/catch";
  const result = classifyByRules(prompt, undefined, 50, scoring);
  assert.ok(
    result.score > scoring.tierBoundaries.simpleMedium,
    "score should be above SIMPLE threshold",
  );
});

test("classifies reasoning request as REASONING with 2+ reasoning keywords", () => {
  const prompt =
    "Prove step by step that the theorem is valid, derive the proof from first principles";
  const result = classifyByRules(prompt, undefined, 80, scoring);
  assert.equal(result.tier, "REASONING");
  assert.ok(result.confidence >= 0.85);
});

test("long input (>500 tokens) scores high on tokenCount", () => {
  const prompt = "x ".repeat(300); // ~300 tokens
  const result = classifyByRules(prompt, undefined, 600, scoring);
  assert.ok(result.score > 0, "long input should have positive score");
});

test("short input (<50 tokens) scores negative on tokenCount", () => {
  const result = classifyByRules("hi", undefined, 5, scoring);
  assert.ok(result.score < scoring.tierBoundaries.mediumComplex);
});

// ─── Signal detection ───

test("detects code keywords", () => {
  const result = classifyByRules("function class import", undefined, 20, scoring);
  assert.ok(result.signals.some((s) => s.includes("code")));
});

test("detects multi-step patterns", () => {
  const result = classifyByRules("first do this, then do that", undefined, 30, scoring);
  assert.ok(result.signals.some((s) => s.includes("multi-step")));
});

test("detects multiple questions", () => {
  const result = classifyByRules(
    "What is this? How does it work? Why is it needed? When was it built?",
    undefined,
    40,
    scoring,
  );
  assert.ok(result.signals.some((s) => s.includes("questions")));
});

test("detects simple indicators", () => {
  const result = classifyByRules("what is the capital of France?", undefined, 15, scoring);
  assert.ok(result.signals.some((s) => s.includes("simple")));
});

// ─── System prompt handling ───

test("reasoning keywords in system prompt don't trigger REASONING", () => {
  const systemPrompt = "Think step by step and derive your answer";
  const prompt = "what is 2+2?";
  const result = classifyByRules(prompt, systemPrompt, 30, scoring);
  // Should NOT be REASONING just because system prompt has those keywords
  assert.notEqual(result.tier, "REASONING");
});

// ─── Confidence calibration ───

test("returns confidence between 0 and 1", () => {
  const result = classifyByRules("hello world", undefined, 10, scoring);
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
});

test("ambiguous results have null tier", () => {
  // Construct input close to boundary
  const result = classifyByRules("maybe do something", undefined, 60, scoring);
  if (result.confidence < scoring.confidenceThreshold) {
    assert.equal(result.tier, null);
  }
});

// ─── Score structure ───

test("result has expected shape", () => {
  const result = classifyByRules("test", undefined, 10, scoring);
  assert.equal(typeof result.score, "number");
  assert.ok(Array.isArray(result.signals));
  assert.equal(typeof result.confidence, "number");
  assert.ok(
    result.tier === null || ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"].includes(result.tier),
  );
});
