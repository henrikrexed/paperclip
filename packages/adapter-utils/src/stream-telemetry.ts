/**
 * Agent stream telemetry decoder.
 *
 * Parses an agent run's streamed stdout (Claude/Anthropic stream-json lines)
 * into normalized, vendor-neutral telemetry blocks that the server can forward
 * as `agent.session.*` bus events. The observability plugin then turns those
 * events into child spans (chat turns, tool / MCP / skill executions).
 *
 * The decoder deliberately emits only structural metadata — tool names, token
 * counts, error flags — and never raw tool input/result bodies or message
 * text. Excluding free-form content is how this layer "respects redaction":
 * no agent-authored payload reaches telemetry, so there is nothing to leak.
 * The few identifier fields that survive (paths embedded in a tool name, a
 * skill name) are still passed through home-path redaction defensively.
 */

import { redactHomePathUserSegments } from "./log-redaction.js";

export type AgentStreamToolKind = "tool" | "mcp" | "skill";

export type AgentStreamTelemetryBlock =
  | {
      kind: "chat";
      model: string;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      stopReason: string | null;
    }
  | {
      kind: "tool_use";
      toolUseId: string;
      toolName: string;
      toolKind: AgentStreamToolKind;
      /** MCP server segment parsed from an `mcp__<server>__<tool>` name. */
      mcpServer: string | null;
      /** Skill identifier parsed from a `Skill` tool invocation. */
      skillName: string | null;
    }
  | {
      kind: "tool_result";
      toolUseId: string;
      isError: boolean;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Classify a tool invocation by its name. Anthropic-style MCP tools follow the
 * `mcp__<server>__<tool>` convention; Paperclip skills are invoked through the
 * built-in `Skill` tool with the skill name in `input.skill`.
 */
function classifyTool(
  name: string,
  input: Record<string, unknown> | null,
): { toolKind: AgentStreamToolKind; mcpServer: string | null; skillName: string | null } {
  if (name.startsWith("mcp__")) {
    const segments = name.split("__");
    const mcpServer = segments.length >= 2 && segments[1] ? segments[1] : null;
    return { toolKind: "mcp", mcpServer, skillName: null };
  }
  if (name === "Skill") {
    const skillName =
      asString(input?.skill) || asString(input?.command) || asString(input?.name) || null;
    return { toolKind: "skill", mcpServer: null, skillName };
  }
  return { toolKind: "tool", mcpServer: null, skillName: null };
}

function decodeLine(line: string): AgentStreamTelemetryBlock[] {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return [];

  let parsed: Record<string, unknown> | null;
  try {
    parsed = asRecord(JSON.parse(trimmed));
  } catch {
    return [];
  }
  if (!parsed) return [];

  const type = asString(parsed.type);

  if (type === "assistant") {
    const message = asRecord(parsed.message) ?? {};
    const blocks: AgentStreamTelemetryBlock[] = [];

    const usage = asRecord(message.usage);
    const model = asString(message.model);
    if (model) {
      blocks.push({
        kind: "chat",
        model: redactHomePathUserSegments(model),
        inputTokens: asNumber(usage?.input_tokens),
        outputTokens: asNumber(usage?.output_tokens),
        cachedInputTokens: asNumber(usage?.cache_read_input_tokens),
        stopReason: asString(message.stop_reason) || null,
      });
    }

    const content = Array.isArray(message.content) ? message.content : [];
    for (const blockRaw of content) {
      const block = asRecord(blockRaw);
      if (!block || asString(block.type) !== "tool_use") continue;
      const toolName = asString(block.name) || "unknown";
      const input = asRecord(block.input);
      const { toolKind, mcpServer, skillName } = classifyTool(toolName, input);
      blocks.push({
        kind: "tool_use",
        toolUseId: asString(block.id) || asString(block.tool_use_id),
        toolName: redactHomePathUserSegments(toolName),
        toolKind,
        mcpServer: mcpServer ? redactHomePathUserSegments(mcpServer) : null,
        skillName: skillName ? redactHomePathUserSegments(skillName) : null,
      });
    }
    return blocks;
  }

  if (type === "user") {
    const message = asRecord(parsed.message) ?? {};
    const content = Array.isArray(message.content) ? message.content : [];
    const blocks: AgentStreamTelemetryBlock[] = [];
    for (const blockRaw of content) {
      const block = asRecord(blockRaw);
      if (!block || asString(block.type) !== "tool_result") continue;
      const toolUseId = asString(block.tool_use_id);
      if (!toolUseId) continue;
      blocks.push({ kind: "tool_result", toolUseId, isError: block.is_error === true });
    }
    return blocks;
  }

  return [];
}

/**
 * Decode an agent stdout chunk into telemetry blocks. A chunk may contain
 * zero, one, or several newline-delimited stream-json lines (the run-log
 * pipeline batches and truncates output), so each line is parsed independently
 * and non-JSON lines are silently skipped.
 */
export function decodeAgentStreamTelemetry(chunk: string): AgentStreamTelemetryBlock[] {
  if (!chunk) return [];
  const blocks: AgentStreamTelemetryBlock[] = [];
  for (const line of chunk.split("\n")) {
    if (!line) continue;
    blocks.push(...decodeLine(line));
  }
  return blocks;
}
