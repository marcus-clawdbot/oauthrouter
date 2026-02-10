import test from "node:test";
import assert from "node:assert/strict";

import { normalizeDeepSeekChatCompletionsRequest } from "../../dist/index.js";

test("deepseek normalization strips router prefix and preserves tools", () => {
  const req = {
    model: "deepseek/deepseek-chat",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    tools: [
      {
        type: "function",
        function: {
          name: "exec",
          description: "run shell",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      },
    ],
    tool_choice: "auto",
    // unknown field should be dropped
    frequency_penalty: 1,
  };

  const out = normalizeDeepSeekChatCompletionsRequest(req);
  assert.equal(out.model, "deepseek-chat");
  assert.ok(Array.isArray(out.tools));
  assert.equal(out.tool_choice, "auto");
  assert.equal(out.frequency_penalty, undefined);
});
