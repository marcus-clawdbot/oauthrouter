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

export type OpenAIChatCompletionsRequest = {
  model?: string;
  messages?: OpenAIChatMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  [key: string]: unknown;
};

export type AnthropicTextBlock = { type: "text"; text: string };

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: AnthropicTextBlock[];
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
      if (type === "text") {
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

    if (role === "user" || role === "assistant") {
      messages.push({ role, content: [{ type: "text", text }] });
      continue;
    }

    // Unknown roles ignored in v0.
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

  return out;
}

function anthropicStopReasonToOpenAiFinishReason(
  stop: string | null | undefined,
): "stop" | "length" | "content_filter" | null {
  if (!stop) return null;
  switch (stop) {
    case "end_turn":
    case "stop_sequence":
    case "tool_use":
      return "stop";
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

  const input = rsp.usage?.input_tokens ?? 0;
  const output = rsp.usage?.output_tokens ?? 0;

  return {
    id: rsp.id ?? `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: opts.requestedModel ?? rsp.model ?? "unknown",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
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
