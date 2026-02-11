import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAnthropicMessagesRequestFromOpenAI,
  anthropicMessagesResponseToOpenAIChatCompletion,
  toAnthropicModelId,
} from "../../dist/index.js";

// ─── toAnthropicModelId ───

test("strips anthropic/ prefix", () => {
  assert.equal(toAnthropicModelId("anthropic/claude-sonnet-4-5"), "claude-sonnet-4-5");
});

test("normalizes dotted version to dashed", () => {
  assert.equal(toAnthropicModelId("anthropic/claude-haiku-4.5"), "claude-haiku-4-5");
  assert.equal(toAnthropicModelId("claude-opus-4.5"), "claude-opus-4-5");
});

test("passes through already-dashed IDs unchanged", () => {
  assert.equal(toAnthropicModelId("claude-sonnet-4-5"), "claude-sonnet-4-5");
});

// ─── buildAnthropicMessagesRequestFromOpenAI ───

test("converts basic user message", () => {
  const req = buildAnthropicMessagesRequestFromOpenAI({
    model: "anthropic/claude-sonnet-4-5",
    messages: [{ role: "user", content: "Hello" }],
  });
  assert.equal(req.model, "claude-sonnet-4-5");
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].role, "user");
  assert.deepEqual(req.messages[0].content, [{ type: "text", text: "Hello" }]);
});

test("extracts system prompt into structured blocks with cache_control (FIX-2)", () => {
  const req = buildAnthropicMessagesRequestFromOpenAI({
    model: "anthropic/claude-sonnet-4-5",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hi" },
    ],
  });
  // FIX-2: system should be an array with cache_control
  assert.ok(Array.isArray(req.system), "system should be an array for prompt caching");
  assert.equal(req.system[0].type, "text");
  assert.equal(req.system[0].text, "You are a helpful assistant.");
  assert.deepEqual(req.system[0].cache_control, { type: "ephemeral" });
});

test("concatenates multiple system messages", () => {
  const req = buildAnthropicMessagesRequestFromOpenAI({
    model: "anthropic/claude-sonnet-4-5",
    messages: [
      { role: "system", content: "Part 1" },
      { role: "system", content: "Part 2" },
      { role: "user", content: "Hi" },
    ],
  });
  assert.ok(Array.isArray(req.system));
  assert.ok(req.system[0].text.includes("Part 1"));
  assert.ok(req.system[0].text.includes("Part 2"));
});

test("handles content as array blocks (OpenClaw format)", () => {
  const req = buildAnthropicMessagesRequestFromOpenAI({
    model: "anthropic/claude-sonnet-4-5",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Hello from array" }],
      },
    ],
  });
  // Should extract text from array blocks
  const textBlock = req.messages[0].content.find((b) => b.type === "text");
  assert.ok(textBlock);
  assert.equal(textBlock.text, "Hello from array");
});

test("converts tool_calls in assistant message", () => {
  const req = buildAnthropicMessagesRequestFromOpenAI({
    model: "anthropic/claude-sonnet-4-5",
    messages: [
      { role: "user", content: "Search for cats" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: { name: "web_search", arguments: '{"query":"cats"}' },
          },
        ],
      },
    ],
  });
  const assistantMsg = req.messages[1];
  assert.equal(assistantMsg.role, "assistant");
  const toolUse = assistantMsg.content.find((b) => b.type === "tool_use");
  assert.ok(toolUse);
  assert.equal(toolUse.id, "call_123");
  assert.equal(toolUse.name, "web_search");
  assert.deepEqual(toolUse.input, { query: "cats" });
});

test("converts tool result message", () => {
  const req = buildAnthropicMessagesRequestFromOpenAI({
    model: "anthropic/claude-sonnet-4-5",
    messages: [{ role: "tool", content: "Result data", tool_call_id: "call_123" }],
  });
  assert.equal(req.messages[0].role, "user");
  const block = req.messages[0].content[0];
  assert.equal(block.type, "tool_result");
  assert.equal(block.tool_use_id, "call_123");
  assert.equal(block.content, "Result data");
});

test("converts OpenAI tools to Anthropic tools", () => {
  const req = buildAnthropicMessagesRequestFromOpenAI({
    model: "anthropic/claude-sonnet-4-5",
    messages: [{ role: "user", content: "Hi" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get current weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ],
    tool_choice: "auto",
  });
  assert.ok(req.tools);
  assert.equal(req.tools.length, 1);
  assert.equal(req.tools[0].name, "get_weather");
  assert.equal(req.tools[0].description, "Get current weather");
  assert.deepEqual(req.tool_choice, { type: "auto" });
});

test("tool_choice 'none' omits tools entirely", () => {
  const req = buildAnthropicMessagesRequestFromOpenAI({
    model: "anthropic/claude-sonnet-4-5",
    messages: [{ role: "user", content: "Hi" }],
    tools: [{ type: "function", function: { name: "foo", parameters: {} } }],
    tool_choice: "none",
  });
  assert.equal(req.tools, undefined);
});

test("tool_choice 'required' maps to Anthropic 'any'", () => {
  const req = buildAnthropicMessagesRequestFromOpenAI({
    model: "anthropic/claude-sonnet-4-5",
    messages: [{ role: "user", content: "Hi" }],
    tools: [{ type: "function", function: { name: "foo", parameters: {} } }],
    tool_choice: "required",
  });
  assert.deepEqual(req.tool_choice, { type: "any" });
});

test("passes temperature and top_p", () => {
  const req = buildAnthropicMessagesRequestFromOpenAI({
    model: "anthropic/claude-sonnet-4-5",
    messages: [{ role: "user", content: "Hi" }],
    temperature: 0.7,
    top_p: 0.9,
  });
  assert.equal(req.temperature, 0.7);
  assert.equal(req.top_p, 0.9);
});

test("converts stop sequences", () => {
  const req = buildAnthropicMessagesRequestFromOpenAI({
    model: "anthropic/claude-sonnet-4-5",
    messages: [{ role: "user", content: "Hi" }],
    stop: ["END", "STOP"],
  });
  assert.deepEqual(req.stop_sequences, ["END", "STOP"]);
});

test("FIX-6: default max_tokens is 16384", () => {
  const req = buildAnthropicMessagesRequestFromOpenAI({
    model: "anthropic/claude-sonnet-4-5",
    messages: [{ role: "user", content: "Hi" }],
  });
  assert.equal(req.max_tokens, 16384);
});

test("explicit max_tokens is preserved", () => {
  const req = buildAnthropicMessagesRequestFromOpenAI({
    model: "anthropic/claude-sonnet-4-5",
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 1024,
  });
  assert.equal(req.max_tokens, 1024);
});

test("throws on missing model", () => {
  assert.throws(() => {
    buildAnthropicMessagesRequestFromOpenAI({
      messages: [{ role: "user", content: "Hi" }],
    });
  }, /Missing required field: model/);
});

// ─── FIX-5: Image content blocks ───

test("FIX-5: translates image_url with URL to Anthropic image block", () => {
  const req = buildAnthropicMessagesRequestFromOpenAI({
    model: "anthropic/claude-sonnet-4-5",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image_url", image_url: { url: "https://example.com/cat.jpg" } },
        ],
      },
    ],
  });
  const msg = req.messages[0];
  const imageBlock = msg.content.find((b) => b.type === "image");
  assert.ok(imageBlock, "should have an image block");
  assert.equal(imageBlock.source.type, "url");
  assert.equal(imageBlock.source.url, "https://example.com/cat.jpg");
});

test("FIX-5: translates base64 data URI to Anthropic base64 image block", () => {
  const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const req = buildAnthropicMessagesRequestFromOpenAI({
    model: "anthropic/claude-sonnet-4-5",
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: dataUri } }],
      },
    ],
  });
  const msg = req.messages[0];
  const imageBlock = msg.content.find((b) => b.type === "image");
  assert.ok(imageBlock, "should have an image block");
  assert.equal(imageBlock.source.type, "base64");
  assert.equal(imageBlock.source.media_type, "image/png");
  assert.equal(imageBlock.source.data, "iVBORw0KGgoAAAANSUhEUg==");
});

test("FIX-5: image-only message has no empty text block", () => {
  const req = buildAnthropicMessagesRequestFromOpenAI({
    model: "anthropic/claude-sonnet-4-5",
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/cat.jpg" } }],
      },
    ],
  });
  const msg = req.messages[0];
  const textBlocks = msg.content.filter((b) => b.type === "text");
  // Should not have "(empty message)" text block when there's an image
  for (const tb of textBlocks) {
    assert.notEqual(tb.text, "(empty message)");
  }
});

// ─── anthropicMessagesResponseToOpenAIChatCompletion ───

test("converts basic text response", () => {
  const result = anthropicMessagesResponseToOpenAIChatCompletion({
    id: "msg_123",
    role: "assistant",
    content: [{ type: "text", text: "Hello!" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  assert.equal(result.id, "msg_123");
  assert.equal(result.object, "chat.completion");
  assert.equal(result.choices[0].message.content, "Hello!");
  assert.equal(result.choices[0].finish_reason, "stop");
  assert.equal(result.usage.prompt_tokens, 10);
  assert.equal(result.usage.completion_tokens, 5);
  assert.equal(result.usage.total_tokens, 15);
});

test("converts tool_use response to OpenAI tool_calls", () => {
  const result = anthropicMessagesResponseToOpenAIChatCompletion({
    id: "msg_456",
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_1", name: "search", input: { q: "cats" } }],
    stop_reason: "tool_use",
    usage: { input_tokens: 20, output_tokens: 15 },
  });
  assert.equal(result.choices[0].finish_reason, "tool_calls");
  const tc = result.choices[0].message.tool_calls;
  assert.ok(tc);
  assert.equal(tc.length, 1);
  assert.equal(tc[0].id, "toolu_1");
  assert.equal(tc[0].function.name, "search");
  assert.equal(tc[0].function.arguments, '{"q":"cats"}');
});

test("maps max_tokens stop_reason to length", () => {
  const result = anthropicMessagesResponseToOpenAIChatCompletion({
    content: [{ type: "text", text: "truncated" }],
    stop_reason: "max_tokens",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  assert.equal(result.choices[0].finish_reason, "length");
});

test("uses requestedModel option for model field", () => {
  const result = anthropicMessagesResponseToOpenAIChatCompletion(
    { content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn" },
    { requestedModel: "anthropic/claude-opus-4-6" },
  );
  assert.equal(result.model, "anthropic/claude-opus-4-6");
});
