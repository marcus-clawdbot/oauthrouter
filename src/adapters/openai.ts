/**
 * OpenAI adapter
 *
 * OpenAI's API is already OpenAI-compatible. The main job here is to normalize
 * router model IDs (which are often provider-prefixed) into OpenAI's expected
 * model IDs.
 */

import type { OpenAIChatCompletionsRequest } from "./anthropic.js";

export function toOpenAiModelId(routerModelId: string): string {
  if (routerModelId.startsWith("openai/")) return routerModelId.slice("openai/".length);
  return routerModelId;
}

export function normalizeOpenAiChatCompletionsRequest(
  req: OpenAIChatCompletionsRequest,
): OpenAIChatCompletionsRequest {
  const model = typeof req.model === "string" ? req.model.trim() : "";
  if (!model) return req;

  return {
    ...req,
    model: toOpenAiModelId(model),
  };
}
