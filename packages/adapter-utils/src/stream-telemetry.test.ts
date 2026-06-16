import { describe, expect, it } from "vitest";
import { decodeAgentStreamTelemetry } from "./stream-telemetry.js";

function assistant(content: unknown[], usage?: Record<string, unknown>, model = "claude-opus-4-8"): string {
  return JSON.stringify({
    type: "assistant",
    message: { model, stop_reason: "tool_use", usage, content },
  });
}

function userToolResult(toolUseId: string, isError = false): string {
  return JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError }] },
  });
}

describe("decodeAgentStreamTelemetry", () => {
  it("returns no blocks for empty or non-JSON chunks", () => {
    expect(decodeAgentStreamTelemetry("")).toEqual([]);
    expect(decodeAgentStreamTelemetry("plain stdout noise\n")).toEqual([]);
    expect(decodeAgentStreamTelemetry("{ truncated json")).toEqual([]);
  });

  it("emits a chat block per assistant message with model + usage", () => {
    const blocks = decodeAgentStreamTelemetry(
      assistant([], { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 90 }),
    );
    expect(blocks).toEqual([
      {
        kind: "chat",
        model: "claude-opus-4-8",
        inputTokens: 120,
        outputTokens: 30,
        cachedInputTokens: 90,
        stopReason: "tool_use",
      },
    ]);
  });

  it("classifies a plain tool_use as kind 'tool'", () => {
    const blocks = decodeAgentStreamTelemetry(
      assistant([{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/x" } }]),
    );
    const toolUse = blocks.find((b) => b.kind === "tool_use");
    expect(toolUse).toMatchObject({
      kind: "tool_use",
      toolUseId: "tu_1",
      toolName: "Read",
      toolKind: "tool",
      mcpServer: null,
      skillName: null,
    });
  });

  it("classifies mcp__server__tool as kind 'mcp' with server segment", () => {
    const blocks = decodeAgentStreamTelemetry(
      assistant([{ type: "tool_use", id: "tu_2", name: "mcp__mempalace__mempalace_search", input: {} }]),
    );
    const toolUse = blocks.find((b) => b.kind === "tool_use");
    expect(toolUse).toMatchObject({
      kind: "tool_use",
      toolKind: "mcp",
      mcpServer: "mempalace",
      toolName: "mcp__mempalace__mempalace_search",
    });
  });

  it("classifies the Skill tool as kind 'skill' with skill name", () => {
    const blocks = decodeAgentStreamTelemetry(
      assistant([{ type: "tool_use", id: "tu_3", name: "Skill", input: { skill: "dt-app-dashboards" } }]),
    );
    const toolUse = blocks.find((b) => b.kind === "tool_use");
    expect(toolUse).toMatchObject({ kind: "tool_use", toolKind: "skill", skillName: "dt-app-dashboards" });
  });

  it("emits a tool_result block carrying the error flag", () => {
    const blocks = decodeAgentStreamTelemetry(userToolResult("tu_1", true));
    expect(blocks).toEqual([{ kind: "tool_result", toolUseId: "tu_1", isError: true }]);
  });

  it("parses batched, newline-delimited lines independently", () => {
    const chunk = [
      assistant([{ type: "tool_use", id: "tu_9", name: "Bash", input: {} }], {
        input_tokens: 1,
        output_tokens: 2,
      }),
      "non-json interleaved line",
      userToolResult("tu_9", false),
    ].join("\n");
    const blocks = decodeAgentStreamTelemetry(chunk);
    expect(blocks.map((b) => b.kind)).toEqual(["chat", "tool_use", "tool_result"]);
  });

  it("never emits raw tool input or message text", () => {
    const secret = "super-secret-prompt-body";
    const blocks = decodeAgentStreamTelemetry(
      assistant([
        { type: "text", text: secret },
        { type: "tool_use", id: "tu_x", name: "Bash", input: { command: secret } },
      ]),
    );
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain(secret);
  });
});
