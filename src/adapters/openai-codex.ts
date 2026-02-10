/**
 * OpenAI Codex (chatgpt.com) adapter
 *
 * ROUTER-011:
 *  - Route openai-codex/* models to https://chatgpt.com/backend-api/codex/responses
 *  - Convert OpenAI chat.completions requests -> Codex responses requests
 *  - Extract chatgpt-account-id from the JWT access token
 */

import type { OpenAIChatCompletionsRequest } from "./anthropic.js";

function coerceStringContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (!p || typeof p !== "object") continue;
      const type = (p as { type?: unknown }).type;
      if (type === "text" || type === "input_text") {
        const text = (p as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
    if (parts.length > 0) return parts.join("");
  }
  return "";
}

export function toOpenAICodexModelId(routerModelId: string): string {
  if (routerModelId.startsWith("openai-codex/")) return routerModelId.slice("openai-codex/".length);
  return routerModelId;
}

function base64UrlDecodeToString(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, "base64").toString("utf-8");
}

/**
 * Extracts the ChatGPT account id claim from an OpenAI auth JWT.
 *
 * Claim key: "https://api.openai.com/auth.chatgpt_account_id"
 */
export function extractChatGptAccountIdFromJwt(jwt: string): string | undefined {
  const token = jwt.trim();
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payloadJson = base64UrlDecodeToString(parts[1] ?? "");
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const claim = payload["https://api.openai.com/auth.chatgpt_account_id"];
    if (typeof claim === "string" && claim.trim()) return claim.trim();
    return undefined;
  } catch {
    return undefined;
  }
}

export type CodexResponsesRequest = {
  model: string;
  /** chatgpt.com Codex backend requires store=false (pi-ai compatible). */
  store?: boolean;
  /** Required by chatgpt.com Codex backend (pi-ai sends systemPrompt here). */
  instructions?: string;
  // NOTE: Codex speaks an OpenAI-Responses-like protocol. `input` supports a mixed array
  // of role messages and typed items (e.g. function_call_output).
  input?: any[];
  stream?: boolean;
  // Intentionally omit max_output_tokens: chatgpt.com Codex backend rejects it (pi-ai compatible).

  // Tool calling (Responses API shape).
  tools?: Array<{
    type: "function";
    name: string;
    description?: string;
    parameters?: unknown;
    // When null, Codex is lenient and will still call tools.
    strict?: boolean | null;
  }>;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  text?: { verbosity?: "low" | "medium" | "high" };
  include?: string[];
};

export function buildCodexResponsesRequestFromOpenAIChatCompletions(
  req: OpenAIChatCompletionsRequest,
): CodexResponsesRequest {
  const modelRaw = typeof req.model === "string" ? req.model.trim() : "";
  const model = modelRaw ? toOpenAICodexModelId(modelRaw) : modelRaw;

  // Codex backend expects system prompt as `instructions` (pi-ai compatible).
  // OpenAI chat.completions encodes system prompt via messages with role="system".
  const systemParts: string[] = [];
  const input = Array.isArray(req.messages)
    ? req.messages
        .filter((m) => m && typeof (m as any).role === "string")
        .flatMap((m) => {
          const role = String((m as any).role);
          const text = coerceStringContent((m as any).content);

          if (role === "system") {
            if (text.trim()) systemParts.push(text.trim());
            return [];
          }

          if (role === "user") {
            return [{ role, content: [{ type: "input_text" as const, text }] }];
          }

          if (role === "assistant") {
            const items: any[] = [];
            // Preserve assistant text (if any).
            if (text) {
              items.push({ role, content: [{ type: "output_text" as const, text }] });
            }

            // OpenAI chat.completions tool calls -> Responses-style function_call items.
            const toolCalls = (m as any).tool_calls;
            if (Array.isArray(toolCalls)) {
              for (const tc of toolCalls) {
                if (!tc || typeof tc !== "object") continue;
                const id = typeof (tc as any).id === "string" ? (tc as any).id.trim() : "";
                const fn = (tc as any).function;
                const name = fn && typeof fn.name === "string" ? fn.name.trim() : "";
                const args = fn && typeof fn.arguments === "string" ? fn.arguments : "";
                if (!id || !name) continue;
                // Omit item `id` to avoid strict pairing validation (pi-ai does this cross-model too).
                items.push({
                  type: "function_call",
                  call_id: id,
                  name,
                  arguments: args,
                });
              }
            }

            return items;
          }

          if (role === "tool") {
            const toolCallId =
              typeof (m as any).tool_call_id === "string" ? (m as any).tool_call_id.trim() : "";
            if (!toolCallId) return [];
            return [
              {
                type: "function_call_output",
                call_id: toolCallId,
                output: text || "",
              },
            ];
          }

          return [];
        })
    : undefined;

  const instructions = systemParts.join("\n\n") || "You are a helpful assistant.";

  const out: CodexResponsesRequest = {
    model,
    store: false,
    instructions,
    input,
  };

  // Provider normalization:
  // The chatgpt.com Codex backend has been observed to reject some OpenAI chat.completions parameters
  // (e.g. "temperature") with a 400. Keep the upstream request minimal for reliability.

  // Codex backend requires stream=true. If the caller asked for non-streaming,
  // OAuthRouter will still request SSE upstream and then aggregate/map back to
  // a normal OpenAI chat.completion JSON response.
  out.stream = true;

  // Tool calling: Codex backend expects Responses-style tools (top-level name/description/parameters).
  const rawTools = (req as any).tools;
  if (Array.isArray(rawTools) && rawTools.length > 0) {
    out.tools = rawTools
      .map((t: any) => {
        if (!t || typeof t !== "object") return null;
        // OpenAI chat.completions shape: { type: "function", function: { name, description, parameters } }
        if (t.type === "function" && t.function && typeof t.function.name === "string") {
          return {
            type: "function" as const,
            name: String(t.function.name),
            description:
              typeof t.function.description === "string" ? t.function.description : undefined,
            parameters: t.function.parameters,
            strict: null,
          };
        }
        // Responses-like shape already.
        if (t.type === "function" && typeof t.name === "string") {
          return {
            type: "function" as const,
            name: String(t.name),
            description: typeof t.description === "string" ? t.description : undefined,
            parameters: t.parameters,
            strict: t.strict ?? null,
          };
        }
        return null;
      })
      .filter(Boolean) as any;

    // Keep Codex behavior close to pi-ai defaults.
    out.tool_choice = (req as any).tool_choice ?? "auto";
    out.parallel_tool_calls = true;
  }

  // Small quality-of-life: align with pi-ai default verbosity.
  out.text = { verbosity: "medium" };
  // Codex supports Responses include hints; harmless if ignored.
  out.include = ["reasoning.encrypted_content"];

  return out;
}
