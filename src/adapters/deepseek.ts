/**
 * DeepSeek adapter
 *
 * DeepSeek is OpenAI-compatible, but model ids are typically un-prefixed.
 * Example: router uses "deepseek/deepseek-chat", upstream expects "deepseek-chat".
 */

import type { OpenAIChatCompletionsRequest } from "./anthropic.js";

export function toDeepSeekModelId(routerModelId: string): string {
  if (routerModelId.startsWith("deepseek/")) return routerModelId.slice("deepseek/".length);
  return routerModelId;
}

export function normalizeDeepSeekChatCompletionsRequest(
  req: OpenAIChatCompletionsRequest,
): OpenAIChatCompletionsRequest {
  const model = typeof req.model === "string" ? req.model.trim() : "";
  if (!model) return req;

  // Keep a conservative allowlist to avoid provider-side 400s on unknown fields.
  // DeepSeek is mostly OpenAI-compatible, but it may reject fields we don't care about.
  const out: Record<string, unknown> = {};
  out.model = toDeepSeekModelId(model);

  if (Array.isArray(req.messages)) out.messages = req.messages;
  if (typeof (req as any).max_tokens === "number") out.max_tokens = (req as any).max_tokens;
  if (typeof (req as any).temperature === "number") out.temperature = (req as any).temperature;
  if (typeof (req as any).top_p === "number") out.top_p = (req as any).top_p;
  if (typeof (req as any).stop === "string" || Array.isArray((req as any).stop))
    out.stop = (req as any).stop;
  if (typeof (req as any).stream === "boolean") out.stream = (req as any).stream;

  if (Array.isArray((req as any).tools)) out.tools = (req as any).tools;
  if ((req as any).tool_choice !== undefined) out.tool_choice = (req as any).tool_choice;

  return out as OpenAIChatCompletionsRequest;
}
