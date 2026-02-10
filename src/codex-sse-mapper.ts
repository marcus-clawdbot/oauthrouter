// Codex (chatgpt.com) Responses SSE -> OpenAI chat.completions SSE mapper.
//
// Why this exists:
// - We need stable tool-call streaming semantics so OpenClaw can run tool loops.
// - Codex sometimes emits `response.function_call_arguments.*` events with missing `call_id`.
// - Codex may emit both argument deltas and a final "done" with the full JSON; emitting both
//   breaks downstream concatenation-based parsers (duplicate JSON).

export type ChatCompletionChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model?: string;
  choices: Array<{
    index: 0;
    delta: Record<string, unknown>;
    finish_reason?: string | null;
  }>;
};

type MapperState = {
  id: string;
  created: number;
  requestedModel?: string;
  toolCallIndexById: Map<string, number>;
  toolCallNameById: Map<string, string>;
  sawArgsDeltaById: Set<string>;
  activeToolCallId: string | null;
  sawToolCalls: boolean;
};

function coerceArgsString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") return JSON.stringify(raw);
  return "";
}

function extractDeltaString(d: unknown): string {
  if (typeof d === "string") return d;
  if (!d || typeof d !== "object") return "";
  const obj = d as any;
  if (typeof obj.partial_json === "string") return String(obj.partial_json);
  if (typeof obj.delta === "string") return String(obj.delta);
  if (typeof obj.arguments === "string") return String(obj.arguments);
  return "";
}

export function createCodexSseToChatCompletionsMapper(options: {
  created: number;
  idFallback: string;
  requestedModel?: string;
}): {
  handlePayload: (payload: any) => ChatCompletionChunk[];
  finalize: () => { finalChunk: ChatCompletionChunk; sawToolCalls: boolean };
} {
  const state: MapperState = {
    id: options.idFallback,
    created: options.created,
    requestedModel: options.requestedModel,
    toolCallIndexById: new Map(),
    toolCallNameById: new Map(),
    sawArgsDeltaById: new Set(),
    activeToolCallId: null,
    sawToolCalls: false,
  };

  function setIdFromPayload(payload: any) {
    const rsp = payload?.response;
    if (rsp && typeof rsp === "object" && typeof rsp.id === "string" && rsp.id.trim()) {
      state.id = rsp.id.trim();
    }
  }

  function chunk(
    delta: Record<string, unknown>,
    finishReason?: string | null,
  ): ChatCompletionChunk {
    return {
      id: state.id,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.requestedModel,
      choices: [
        { index: 0, delta, ...(finishReason !== undefined ? { finish_reason: finishReason } : {}) },
      ],
    };
  }

  function ensureToolIndex(callId: string): number {
    if (!state.toolCallIndexById.has(callId))
      state.toolCallIndexById.set(callId, state.toolCallIndexById.size);
    return state.toolCallIndexById.get(callId) ?? 0;
  }

  function toolDelta(
    callId: string,
    name: string | undefined,
    argsDelta: string,
  ): ChatCompletionChunk {
    const idx = ensureToolIndex(callId);
    const n = name || state.toolCallNameById.get(callId) || undefined;
    return chunk({
      tool_calls: [
        {
          index: idx,
          id: callId,
          type: "function",
          function: { ...(n ? { name: n } : {}), arguments: argsDelta },
        },
      ],
    });
  }

  return {
    handlePayload(payload: any): ChatCompletionChunk[] {
      if (!payload || typeof payload !== "object") return [];
      setIdFromPayload(payload);

      const type = typeof payload.type === "string" ? payload.type : "";
      if (type === "response.output_text.delta" && typeof payload.delta === "string") {
        return [chunk({ content: payload.delta })];
      }

      // Tool calling (Responses SSE -> OpenAI chat.completions SSE)
      if (type === "response.output_item.added") {
        const item = payload.item;
        if (item && typeof item === "object" && item.type === "function_call") {
          const callId = typeof item.call_id === "string" ? item.call_id : "";
          const name = typeof item.name === "string" ? item.name : "";
          if (callId && name) {
            state.sawToolCalls = true;
            state.activeToolCallId = callId;
            state.toolCallNameById.set(callId, name);

            // Do NOT emit arguments here. If later delta events arrive, emitting args here would
            // duplicate JSON and can break downstream tool argument parsing.
            return [toolDelta(callId, name, "")];
          }
        }
        return [];
      }

      if (type === "response.function_call_arguments.delta") {
        const callId =
          typeof payload.call_id === "string"
            ? payload.call_id
            : state.activeToolCallId
              ? state.activeToolCallId
              : "";
        const delta = extractDeltaString(payload.delta);
        if (!callId || !delta) return [];
        state.sawToolCalls = true;
        state.sawArgsDeltaById.add(callId);
        return [toolDelta(callId, undefined, delta)];
      }

      if (type === "response.function_call_arguments.done") {
        const callId =
          typeof payload.call_id === "string"
            ? payload.call_id
            : state.activeToolCallId
              ? state.activeToolCallId
              : "";
        const args = coerceArgsString(payload.arguments);
        if (!callId || !args) return [];

        // If we already streamed deltas for this tool, downstream will concatenate args and this
        // full payload would duplicate JSON.
        if (state.sawArgsDeltaById.has(callId)) return [];

        state.sawToolCalls = true;
        return [toolDelta(callId, undefined, args)];
      }

      return [];
    },

    finalize(): { finalChunk: ChatCompletionChunk; sawToolCalls: boolean } {
      return {
        sawToolCalls: state.sawToolCalls,
        finalChunk: chunk({}, state.sawToolCalls ? "tool_calls" : "stop"),
      };
    },
  };
}
