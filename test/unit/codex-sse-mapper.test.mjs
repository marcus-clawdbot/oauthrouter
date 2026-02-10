import test from "node:test";
import assert from "node:assert/strict";

import { createCodexSseToChatCompletionsMapper } from "../../dist/index.js";

test("codex SSE maps output_text deltas to chat.completion.chunk content", () => {
  const mapper = createCodexSseToChatCompletionsMapper({
    created: 123,
    idFallback: "chatcmpl_fallback",
    requestedModel: "openai-codex/gpt-5.2",
  });

  const chunks = mapper.handlePayload({ type: "response.output_text.delta", delta: "OK" });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].object, "chat.completion.chunk");
  assert.equal(chunks[0].choices[0].delta.content, "OK");

  const fin = mapper.finalize();
  assert.equal(fin.finalChunk.choices[0].finish_reason, "stop");
});

test("codex SSE maps tool calls + argument deltas and does not duplicate JSON on done", () => {
  const mapper = createCodexSseToChatCompletionsMapper({
    created: 123,
    idFallback: "chatcmpl_fallback",
    requestedModel: "openai-codex/gpt-5.2",
  });

  const out1 = mapper.handlePayload({
    type: "response.output_item.added",
    item: { type: "function_call", call_id: "call_1", name: "exec", arguments: "" },
  });
  assert.equal(out1.length, 1);
  assert.equal(out1[0].choices[0].delta.tool_calls[0].id, "call_1");
  assert.equal(out1[0].choices[0].delta.tool_calls[0].function.name, "exec");

  // Codex may omit call_id on argument delta events. The mapper should use the active call id.
  const out2 = mapper.handlePayload({
    type: "response.function_call_arguments.delta",
    call_id: undefined,
    delta: '{"command":"echo ',
  });
  const out3 = mapper.handlePayload({
    type: "response.function_call_arguments.delta",
    call_id: undefined,
    delta: 'hi"}',
  });

  assert.equal(out2.length, 1);
  assert.equal(out3.length, 1);
  assert.equal(out2[0].choices[0].delta.tool_calls[0].id, "call_1");
  assert.equal(out3[0].choices[0].delta.tool_calls[0].id, "call_1");

  // If a "done" event arrives with the full JSON after deltas, we must suppress it.
  const outDone = mapper.handlePayload({
    type: "response.function_call_arguments.done",
    call_id: undefined,
    arguments: { command: "echo hi" },
  });
  assert.equal(outDone.length, 0);

  const fin = mapper.finalize();
  assert.equal(fin.finalChunk.choices[0].finish_reason, "tool_calls");
});

test("codex SSE emits done arguments when no deltas were streamed", () => {
  const mapper = createCodexSseToChatCompletionsMapper({
    created: 123,
    idFallback: "chatcmpl_fallback",
    requestedModel: "openai-codex/gpt-5.2",
  });

  mapper.handlePayload({
    type: "response.output_item.added",
    item: { type: "function_call", call_id: "call_1", name: "exec", arguments: "" },
  });

  const outDone = mapper.handlePayload({
    type: "response.function_call_arguments.done",
    call_id: "call_1",
    arguments: '{"command":"echo hi"}',
  });
  assert.equal(outDone.length, 1);
  assert.equal(
    outDone[0].choices[0].delta.tool_calls[0].function.arguments,
    '{"command":"echo hi"}',
  );
});
