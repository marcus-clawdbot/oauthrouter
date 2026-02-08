/**
 * Anthropic Messages adapter
 *
 * ROUTER-005 (v0):
 * - Translate OpenAI-style /v1/chat/completions request bodies into Anthropic
 *   /v1/messages request bodies.
 * - Map Anthropic /v1/messages responses back into OpenAI-compatible
 *   chat.completion JSON.
 * - Non-streaming only.
 */

export type OpenAIChatMessage = {
  role: string;
  content: unknown;
};

export type OpenAIToolCallFunction = {
  name: string;
  arguments: string;
};

export type OpenAIToolCall = {
  id: string;
  type: "function";
  function: OpenAIToolCallFunction;
};

export type OpenAIChatCompletionsRequest = {
  model?: string;
  messages?: OpenAIChatMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: Array<{
    type: string;
    function: { name: string; description?: string; parameters?: Record<string, unknown> };
  }>;
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  [key: string]: unknown;
};

export type AnthropicTextBlock = { type: "text"; text: string };
export type AnthropicToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
export type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export type AnthropicTool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
};

export type AnthropicMessagesRequest = {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  metadata?: unknown;
  tools?: AnthropicTool[];
  tool_choice?: { type: string; name?: string };
};

export type AnthropicMessagesResponse = {
  id?: string;
  type?: string;
  role?: string;
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string | null;
  stop_sequence?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
};

function coerceStringContent(content: unknown): string {
  if (typeof content === "string") return content;

  // OpenAI can send content blocks: [{ type: 'text', text: '...' }, ...]
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (!p || typeof p !== "object") continue;
      const type = (p as { type?: unknown }).type;
      if (type === "text" || type === "input_text" || type === "output_text") {
        const text = (p as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
    if (parts.length > 0) return parts.join("");
  }

  return "";
}

export function toAnthropicModelId(openAiModel: string): string {
  // Router model ids are typically provider-prefixed: "anthropic/<model>".
  // Normalize common alias formats to Anthropic-accepted IDs.
  //
  // ROUTER-014: Anthropic model ID normalization.
  // Anthropic uses dashed versions (e.g. claude-haiku-4-5). Some callers
  // send dotted versions (claude-haiku-4.5) which 404 upstream.
  const raw = openAiModel.startsWith("anthropic/")
    ? openAiModel.slice("anthropic/".length)
    : openAiModel;

  // Normalize: claude-{haiku|sonnet|opus}-4.5 -> claude-*-4-5
  return raw.replace(/\b(claude-(?:haiku|sonnet|opus)-4)\.5\b/g, "$1-5");
}

export function buildAnthropicMessagesRequestFromOpenAI(
  req: OpenAIChatCompletionsRequest,
): AnthropicMessagesRequest {
  const model = typeof req.model === "string" ? req.model.trim() : "";
  if (!model) throw new Error("Missing required field: model");

  const openAiMessages = Array.isArray(req.messages) ? req.messages : [];
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  for (const m of openAiMessages) {
    if (!m || typeof m !== "object") continue;
    const role = typeof m.role === "string" ? m.role : "";
    const text = coerceStringContent(m.content);

    if (role === "system") {
      if (text) systemParts.push(text);
      continue;
    }

    if (role === "tool") {
      // OpenAI tool result → Anthropic tool_result inside a user message
      const toolCallId = typeof (m as any).tool_call_id === "string" ? (m as any).tool_call_id : "";
      const resultContent = text || "";
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolCallId, content: resultContent }],
      });
      continue;
    }

    if (role === "assistant") {
      const contentBlocks: AnthropicContentBlock[] = [];
      if (text) {
        contentBlocks.push({ type: "text", text });
      }
      // Convert OpenAI tool_calls to Anthropic tool_use blocks
      const toolCalls = Array.isArray((m as any).tool_calls) ? (m as any).tool_calls : [];
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== "object") continue;
        const fn = tc.function;
        if (!fn || typeof fn !== "object") continue;
        let parsedInput: unknown = {};
        if (typeof fn.arguments === "string") {
          try {
            parsedInput = JSON.parse(fn.arguments);
          } catch {
            parsedInput = {};
          }
        }
        contentBlocks.push({
          type: "tool_use",
          id: typeof tc.id === "string" ? tc.id : `toolu_${Date.now()}`,
          name: typeof fn.name === "string" ? fn.name : "",
          input: parsedInput,
        });
      }
      if (contentBlocks.length === 0) {
        contentBlocks.push({ type: "text", text: "..." });
      }
      messages.push({ role: "assistant", content: contentBlocks });
      continue;
    }

    if (role === "user") {
      const content = text || "(empty message)";
      messages.push({ role, content: [{ type: "text", text: content }] });
      continue;
    }

    // Unknown roles ignored.
  }

  const maxTokens =
    typeof req.max_tokens === "number" && Number.isFinite(req.max_tokens)
      ? Math.max(1, Math.floor(req.max_tokens))
      : 4096;

  const stopSequences: string[] | undefined =
    typeof req.stop === "string"
      ? [req.stop]
      : Array.isArray(req.stop)
        ? req.stop.filter((s): s is string => typeof s === "string")
        : undefined;

  const out: AnthropicMessagesRequest = {
    model: toAnthropicModelId(model),
    max_tokens: maxTokens,
    messages,
  };

  const system = systemParts.join("\n\n");
  if (system) out.system = system;

  if (typeof req.temperature === "number") out.temperature = req.temperature;
  if (typeof req.top_p === "number") out.top_p = req.top_p;
  if (stopSequences && stopSequences.length > 0) out.stop_sequences = stopSequences;
  if (req.metadata !== undefined) out.metadata = req.metadata;

  // Convert OpenAI tools → Anthropic tools
  if (Array.isArray(req.tools) && req.tools.length > 0) {
    const toolChoice = req.tool_choice;

    // If tool_choice is "none", don't send tools at all
    if (toolChoice !== "none") {
      out.tools = req.tools
        .filter((t) => t && t.type === "function" && t.function)
        .map((t) => ({
          name: t.function.name,
          ...(t.function.description ? { description: t.function.description } : {}),
          input_schema: t.function.parameters ?? { type: "object", properties: {} },
        }));

      if (typeof toolChoice === "string") {
        if (toolChoice === "required") {
          out.tool_choice = { type: "any" };
        } else if (toolChoice === "auto") {
          out.tool_choice = { type: "auto" };
        }
      } else if (toolChoice && typeof toolChoice === "object" && toolChoice.type === "function") {
        out.tool_choice = { type: "tool", name: toolChoice.function.name };
      }
    }
  }

  return out;
}

function anthropicStopReasonToOpenAiFinishReason(
  stop: string | null | undefined,
): "stop" | "length" | "content_filter" | "tool_calls" | null {
  if (!stop) return null;
  switch (stop) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

export function anthropicMessagesResponseToOpenAIChatCompletion(
  rsp: AnthropicMessagesResponse,
  opts: { requestedModel?: string } = {},
): Record<string, unknown> {
  const blocks = Array.isArray(rsp.content) ? rsp.content : [];
  const text = blocks
    .filter((b) => b && (b.type === "text" || b.type === undefined))
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("");

  // Extract tool_use blocks → OpenAI tool_calls
  const toolCalls: OpenAIToolCall[] = blocks
    .filter(
      (b): b is { type: string; id: string; name: string; input: unknown } =>
        b != null && b.type === "tool_use",
    )
    .map((b) => ({
      id: b.id,
      type: "function" as const,
      function: {
        name: b.name,
        arguments: JSON.stringify(b.input ?? {}),
      },
    }));

  const input = rsp.usage?.input_tokens ?? 0;
  const output = rsp.usage?.output_tokens ?? 0;

  const message: Record<string, unknown> = {
    role: "assistant",
    content: text || null,
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: rsp.id ?? `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: opts.requestedModel ?? rsp.model ?? "unknown",
    choices: [
      {
        index: 0,
        message,
        finish_reason: anthropicStopReasonToOpenAiFinishReason(rsp.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: input + output,
    },
  };
}
