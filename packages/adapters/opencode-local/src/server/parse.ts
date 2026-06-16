import type { AdapterStreamEvent, AdapterToolCallReport, UsageSummary } from "@paperclipai/adapter-utils";
import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

export function parseOpenCodeJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const toolErrors: string[] = [];
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const currentSessionId = asString(event.sessionID, "").trim();
    if (currentSessionId) sessionId = currentSessionId;

    const type = asString(event.type, "");

    if (type === "text") {
      const part = parseObject(event.part);
      const text = asString(part.text, "").trim();
      if (text) messages.push(text);
      continue;
    }

    if (type === "step_finish") {
      const part = parseObject(event.part);
      const tokens = parseObject(part.tokens);
      const cache = parseObject(tokens.cache);
      usage.inputTokens += asNumber(tokens.input, 0);
      usage.cachedInputTokens += asNumber(cache.read, 0);
      usage.outputTokens += asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0);
      costUsd += asNumber(part.cost, 0);
      continue;
    }

    if (type === "tool_use") {
      const part = parseObject(event.part);
      const state = parseObject(part.state);
      if (asString(state.status, "") === "error") {
        const text = asString(state.error, "").trim();
        if (text) toolErrors.push(text);
      }
      continue;
    }

    if (type === "error") {
      const text = errorText(event.error ?? event.message).trim();
      if (text) errors.push(text);
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
    toolErrors,
  };
}

/**
 * Classify an OpenCode tool name into an MCP call, skill invocation, or
 * ordinary tool, deriving the MCP server / skill name where applicable.
 *
 * MCP tools follow the `mcp__<server>__<tool>` convention; skills are invoked
 * through a `Skill`/`skill` tool whose input carries the skill name. Anything
 * else is reported as a plain tool — every call still emits an event so the run
 * span gains a child span regardless of classification.
 */
function classifyOpenCodeToolUse(
  name: string,
  input: Record<string, unknown> | null,
): AdapterToolCallReport {
  let inputSummary: string | null = null;
  if (input && Object.keys(input).length > 0) {
    try {
      inputSummary = JSON.stringify(input).slice(0, 256);
    } catch {
      inputSummary = null;
    }
  }

  if (name.startsWith("mcp__")) {
    const segments = name.split("__");
    return { name, kind: "mcp", mcpServer: segments[1] || null, inputSummary };
  }

  if (name === "Skill" || name === "skill") {
    const skillName =
      asString(input?.skill, "") || asString(input?.command, "") || asString(input?.name, "") || null;
    return { name, kind: "skill", skillName, inputSummary };
  }

  return { name, kind: "tool", inputSummary };
}

/**
 * Incremental JSONL parser for live per-turn telemetry on the OpenCode adapter.
 *
 * Unlike {@link parseOpenCodeJsonl} — which decodes the full stdout once the
 * subprocess exits to build the aggregate result — this consumes stdout chunks
 * as they arrive and invokes `onEvent` for each assistant step (a `step_finish`
 * carrying that step's token usage) and each `tool_use` block (classified by
 * name). The runner forwards these via `AdapterExecutionContext.onStreamEvent`
 * to the observability layer so the run span gains per-turn child spans
 * mirroring the contract established by the claude_local adapter (ISI-1323),
 * instead of a single aggregate `chat <model>` span.
 *
 * OpenCode emits a `tool_use` event repeatedly as a call advances
 * (pending → running → completed/error), so calls are deduped by call id. The
 * model is taken from the configured run model (OpenCode does not reliably echo
 * it per step), with a stream-surfaced model preferred when present.
 */
export function createOpenCodeStreamEventParser(
  onEvent: (event: AdapterStreamEvent) => void | Promise<void>,
  options?: { model?: string },
): { ingest(chunk: string): Promise<void>; flush(): Promise<void> } {
  let buffer = "";
  let model = options?.model ?? "";
  let turnIndex = 0;
  const seenToolCallIds = new Set<string>();

  const processLine = async (rawLine: string): Promise<void> => {
    const line = rawLine.trim();
    if (!line) return;
    const event = parseJson(line);
    if (!event) return;

    const type = asString(event.type, "");
    const part = parseObject(event.part);

    const streamedModel =
      asString(part.modelID, "") ||
      asString(part.model, "") ||
      asString(event.modelID, "") ||
      asString(event.model, "");
    if (streamedModel) model = streamedModel;

    if (type === "tool_use") {
      const name = asString(part.tool, "");
      if (!name) return;
      const id = asString(part.callID, "") || asString(part.id, "");
      if (id && seenToolCallIds.has(id)) return;
      if (id) seenToolCallIds.add(id);
      const state = parseObject(part.state);
      const call = classifyOpenCodeToolUse(name, parseObject(state.input));
      await onEvent({ kind: "tool_call", call: id ? { ...call, id } : call });
      return;
    }

    if (type === "step_finish") {
      const tokens = parseObject(part.tokens);
      const cache = parseObject(tokens.cache);
      const usage: UsageSummary = {
        inputTokens: asNumber(tokens.input, 0),
        cachedInputTokens: asNumber(cache.read, 0),
        outputTokens: asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0),
      };
      const stopReason = asString(part.reason, "") || null;
      await onEvent({ kind: "chat_turn", model, usage, stopReason, turnIndex: turnIndex++ });
    }
  };

  return {
    async ingest(chunk: string): Promise<void> {
      buffer += chunk;
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx >= 0) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        await processLine(line);
        newlineIdx = buffer.indexOf("\n");
      }
    },
    async flush(): Promise<void> {
      if (buffer.length === 0) return;
      const remaining = buffer;
      buffer = "";
      await processLine(remaining);
    },
  };
}

export function isOpenCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session/i.test(
    haystack,
  );
}
