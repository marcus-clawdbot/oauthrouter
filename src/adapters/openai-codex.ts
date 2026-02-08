/**
 * OpenAI Codex (chatgpt.com) adapter
 *
 * ROUTER-011:
 *  - Route openai-codex/* models to https://chatgpt.com/backend-api/codex/responses
 *  - Convert OpenAI chat.completions requests -> Codex responses requests
 *  - Extract chatgpt-account-id from the JWT access token
 */

import type { OpenAIChatCompletionsRequest } from "./anthropic.js";

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
  input?: Array<{ role: string; content: Array<{ type: "input_text"; text: string }> }>;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  // Intentionally omit max_output_tokens: chatgpt.com Codex backend rejects it (pi-ai compatible).
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
        .filter((m) => m && typeof m.role === "string")
        .flatMap((m) => {
          const role = String(m.role);
          const text = typeof m.content === "string" ? m.content : "";

          if (role === "system") {
            if (text.trim()) systemParts.push(text.trim());
            return [];
          }

          if (role === "user" || role === "assistant") {
            return [{ role, content: [{ type: "input_text" as const, text }] }];
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

  if (typeof (req as any).temperature === "number") out.temperature = (req as any).temperature;
  if (typeof (req as any).top_p === "number") out.top_p = (req as any).top_p;
  if (typeof (req as any).stream === "boolean") out.stream = (req as any).stream;

  return out;
}
