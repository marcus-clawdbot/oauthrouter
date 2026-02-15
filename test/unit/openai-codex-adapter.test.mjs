import test from "node:test";
import assert from "node:assert/strict";
import {
  toOpenAICodexModelId,
  extractChatGptAccountIdFromJwt,
  buildCodexResponsesRequestFromOpenAIChatCompletions,
} from "../../dist/index.js";

// ─── toOpenAICodexModelId ───

test("strips openai-codex/ prefix", () => {
  assert.equal(toOpenAICodexModelId("openai-codex/gpt-5.2-codex"), "gpt-5.2-codex");
});

test("passes through non-prefixed model", () => {
  assert.equal(toOpenAICodexModelId("gpt-5.2"), "gpt-5.2");
});

// ─── extractChatGptAccountIdFromJwt ───

test("extracts account ID from valid JWT", () => {
  // Create a minimal JWT with the account ID claim
  const payload = { "https://api.openai.com/auth.chatgpt_account_id": "acc_test123" };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const jwt = `eyJ0eXAiOiJKV1QifQ.${b64}.signature`;
  assert.equal(extractChatGptAccountIdFromJwt(jwt), "acc_test123");
});

test("returns undefined for JWT without claim", () => {
  const payload = { sub: "user123" };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const jwt = `header.${b64}.sig`;
  assert.equal(extractChatGptAccountIdFromJwt(jwt), undefined);
});

test("returns undefined for invalid JWT", () => {
  assert.equal(extractChatGptAccountIdFromJwt("not-a-jwt"), undefined);
  assert.equal(extractChatGptAccountIdFromJwt(""), undefined);
});

// ─── buildCodexResponsesRequestFromOpenAIChatCompletions ───

test("converts basic chat completion to Codex responses format", () => {
  const req = buildCodexResponsesRequestFromOpenAIChatCompletions({
    model: "openai-codex/gpt-5.2-codex",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ],
  });
  assert.equal(req.model, "gpt-5.2-codex");
  assert.equal(req.store, false);
  assert.equal(req.stream, true);
  assert.equal(req.instructions, "You are helpful.");
  assert.ok(Array.isArray(req.input));
  // Should have user message, not system
  assert.equal(req.input.length, 1);
  assert.equal(req.input[0].role, "user");
});

test("handles array content blocks (OpenClaw format)", () => {
  const req = buildCodexResponsesRequestFromOpenAIChatCompletions({
    model: "openai-codex/gpt-5.2-codex",
    messages: [{ role: "user", content: [{ type: "text", text: "Array content" }] }],
  });
  assert.ok(req.input[0].content[0].text === "Array content");
});

test("converts tool_calls to function_call items", () => {
  const req = buildCodexResponsesRequestFromOpenAIChatCompletions({
    model: "openai-codex/gpt-5.2-codex",
    messages: [
      { role: "user", content: "Search" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "search", arguments: '{"q":"test"}' },
          },
        ],
      },
    ],
  });
  const funcCall = req.input.find((i) => i.type === "function_call");
  assert.ok(funcCall);
  assert.equal(funcCall.call_id, "call_1");
  assert.equal(funcCall.name, "search");
  assert.equal(funcCall.arguments, '{"q":"test"}');
});

test("converts tool result to function_call_output", () => {
  const req = buildCodexResponsesRequestFromOpenAIChatCompletions({
    model: "openai-codex/gpt-5.2-codex",
    messages: [{ role: "tool", content: "Result data", tool_call_id: "call_1" }],
  });
  const output = req.input.find((i) => i.type === "function_call_output");
  assert.ok(output);
  assert.equal(output.call_id, "call_1");
  assert.equal(output.output, "Result data");
});

test("converts tools to Responses-style format", () => {
  const req = buildCodexResponsesRequestFromOpenAIChatCompletions({
    model: "openai-codex/gpt-5.2-codex",
    messages: [{ role: "user", content: "Hi" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object" },
        },
      },
    ],
  });
  assert.ok(req.tools);
  assert.equal(req.tools.length, 1);
  assert.equal(req.tools[0].name, "get_weather");
  assert.equal(req.tools[0].strict, null);
  assert.equal(req.parallel_tool_calls, true);
});

test("defaults instructions to helpful assistant when no system prompt", () => {
  const req = buildCodexResponsesRequestFromOpenAIChatCompletions({
    model: "openai-codex/gpt-5.2-codex",
    messages: [{ role: "user", content: "Hi" }],
  });
  assert.equal(req.instructions, "You are a helpful assistant.");
});

// ─── Image / Vision support ───

test("passes image_url content blocks as input_image (URL string)", () => {
  const req = buildCodexResponsesRequestFromOpenAIChatCompletions({
    model: "openai-codex/gpt-5.2-codex",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image_url", image_url: { url: "https://example.com/photo.jpg" } },
        ],
      },
    ],
  });
  assert.equal(req.input.length, 1);
  const blocks = req.input[0].content;
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: "input_text", text: "What is in this image?" });
  assert.deepEqual(blocks[1], { type: "input_image", image_url: "https://example.com/photo.jpg" });
});

test("passes base64 data URI image_url as input_image", () => {
  const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const req = buildCodexResponsesRequestFromOpenAIChatCompletions({
    model: "openai-codex/gpt-5.2-codex",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe" },
          { type: "image_url", image_url: { url: dataUri } },
        ],
      },
    ],
  });
  const blocks = req.input[0].content;
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[1], { type: "input_image", image_url: dataUri });
});

test("handles image-only message (no text)", () => {
  const req = buildCodexResponsesRequestFromOpenAIChatCompletions({
    model: "openai-codex/gpt-5.2-codex",
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/img.png" } }],
      },
    ],
  });
  assert.equal(req.input.length, 1);
  const blocks = req.input[0].content;
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], { type: "input_image", image_url: "https://example.com/img.png" });
});

test("handles image_url as plain string (not object)", () => {
  const req = buildCodexResponsesRequestFromOpenAIChatCompletions({
    model: "openai-codex/gpt-5.2-codex",
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: "https://example.com/direct.jpg" }],
      },
    ],
  });
  const blocks = req.input[0].content;
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], { type: "input_image", image_url: "https://example.com/direct.jpg" });
});

test("always sets stream=true", () => {
  const req = buildCodexResponsesRequestFromOpenAIChatCompletions({
    model: "openai-codex/gpt-5.2-codex",
    messages: [{ role: "user", content: "Hi" }],
    stream: false,
  });
  assert.equal(req.stream, true);
});
