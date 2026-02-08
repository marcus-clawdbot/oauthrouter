/**
 * ROUTER-005: Anthropic adapter integration test (payload build + response mapping)
 *
 * Run:
 *   npx tsup test/anthropic-adapter.ts --format esm --outDir test/dist --no-dts && node test/dist/anthropic-adapter.js
 */

import assert from "node:assert/strict";

import {
  buildAnthropicMessagesRequestFromOpenAI,
  anthropicMessagesResponseToOpenAIChatCompletion,
} from "../src/adapters/anthropic.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    failed++;
  }
}

console.log("\n═══ Anthropic adapter tests ═══\n");

test("build maps system + user messages", () => {
  const out = buildAnthropicMessagesRequestFromOpenAI({
    model: "anthropic/claude-sonnet-4",
    stream: true,
    max_tokens: 123,
    temperature: 0.2,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
    ],
  });

  assert.equal(out.model, "claude-sonnet-4");
  assert.equal(out.max_tokens, 123);
  assert.equal(out.system, "You are a helpful assistant.");
  assert.deepEqual(out.messages, [{ role: "user", content: [{ type: "text", text: "Hello" }] }]);
  assert.equal(out.temperature, 0.2);
});

test("build concatenates multiple system messages", () => {
  const out = buildAnthropicMessagesRequestFromOpenAI({
    model: "anthropic/claude-opus-4",
    max_tokens: 50,
    messages: [
      { role: "system", content: "Line 1" },
      { role: "system", content: "Line 2" },
      { role: "user", content: "Hi" },
    ],
  });

  assert.equal(out.system, "Line 1\n\nLine 2");
});

test("response maps usage + content", () => {
  const mapped = anthropicMessagesResponseToOpenAIChatCompletion(
    {
      id: "msg_123",
      model: "claude-sonnet-4",
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 7, output_tokens: 3 },
    },
    { requestedModel: "anthropic/claude-sonnet-4" },
  );

  assert.equal(mapped.object, "chat.completion");
  assert.equal((mapped.choices as any[])[0].message.role, "assistant");
  assert.equal((mapped.choices as any[])[0].message.content, "OK");
  assert.equal((mapped.usage as any).prompt_tokens, 7);
  assert.equal((mapped.usage as any).completion_tokens, 3);
  assert.equal((mapped.usage as any).total_tokens, 10);
  assert.equal(mapped.model, "anthropic/claude-sonnet-4");
});

console.log("\n════════════════════════════");
console.log(`  ${passed} passed, ${failed} failed`);
console.log("════════════════════════════\n");

process.exit(failed > 0 ? 1 : 0);
