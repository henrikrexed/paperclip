/**
 * Tests for agent-internal session telemetry handlers (ISI-1303):
 * chat turns + tool/MCP/skill execution spans nested under the session span.
 */
import { describe, expect, it } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  handleSessionChatTraces,
  handleSessionChatMetrics,
  handleSessionToolTraces,
  handleSessionToolMetrics,
} from "../src/telemetry/session-handlers.js";
import { METRIC_NAMES } from "../src/constants.js";
import { createTestTelemetryCtx, createMockSpan, makeEvent, type MockSpan } from "./helpers.js";

function withSessionSpan(sessionId: string) {
  const harness = createTestTelemetryCtx();
  const sessionSpan = createMockSpan();
  harness.ctx.activeSessionSpans.set(sessionId, sessionSpan);
  return { ...harness, sessionSpan };
}

describe("handleSessionChatTraces", () => {
  it("creates a chat span under the session span with GenAI attributes", async () => {
    const { ctx, tracer } = withSessionSpan("sess-1");
    await handleSessionChatTraces(
      makeEvent("agent.session.chat", {
        sessionId: "sess-1",
        agentId: "ag-1",
        agentName: "O11y",
        model: "claude-opus-4-8",
        inputTokens: 100,
        outputTokens: 25,
        cachedInputTokens: 80,
        stopReason: "tool_use",
      }),
      ctx,
    );
    const span = tracer._lastSpan as MockSpan;
    expect(span).toBeTruthy();
    expect(span._attributes["gen_ai.operation.name"]).toBe("chat");
    expect(span._attributes["gen_ai.request.model"]).toBe("claude-opus-4-8");
    expect(span._attributes["gen_ai.usage.input_tokens"]).toBe(100);
    expect(span._attributes["gen_ai.usage.output_tokens"]).toBe(25);
    expect(span._attributes["gen_ai.response.finish_reasons"]).toBe("tool_use");
    expect(span._ended).toBe(true);
    expect(span._status.code).toBe(SpanStatusCode.OK);
  });

  it("does nothing when no session span is active", async () => {
    const { ctx, tracer } = createTestTelemetryCtx();
    await handleSessionChatTraces(
      makeEvent("agent.session.chat", { sessionId: "missing", model: "x" }),
      ctx,
    );
    expect(tracer._lastSpan).toBeNull();
  });
});

describe("handleSessionChatMetrics", () => {
  it("increments the chat-turns counter", async () => {
    const { ctx, meter } = createTestTelemetryCtx();
    await handleSessionChatMetrics(
      makeEvent("agent.session.chat", { sessionId: "s", model: "claude-opus-4-8" }),
      ctx,
    );
    const counter = meter._counters.get(METRIC_NAMES.sessionChatTurns);
    expect(counter?.add).toHaveBeenCalledWith(1, expect.objectContaining({ model: "claude-opus-4-8" }));
  });
});

describe("handleSessionToolTraces", () => {
  it("opens an execute_tool span on start and closes it OK on end", async () => {
    const { ctx, tracer } = withSessionSpan("sess-2");
    await handleSessionToolTraces(
      makeEvent("agent.session.tool", {
        sessionId: "sess-2",
        phase: "start",
        toolUseId: "tu-1",
        toolName: "Read",
        toolKind: "tool",
      }),
      ctx,
    );
    const span = tracer._lastSpan as MockSpan;
    expect(span._attributes["gen_ai.operation.name"]).toBe("execute_tool");
    expect(span._attributes["gen_ai.tool.name"]).toBe("Read");
    expect(span._attributes["paperclip.tool.kind"]).toBe("tool");
    expect(span._ended).toBe(false);

    await handleSessionToolTraces(
      makeEvent("agent.session.tool", { sessionId: "sess-2", phase: "end", toolUseId: "tu-1", isError: false }),
      ctx,
    );
    expect(span._ended).toBe(true);
    expect(span._status.code).toBe(SpanStatusCode.OK);
  });

  it("marks the span ERROR when the tool result is an error", async () => {
    const { ctx, tracer } = withSessionSpan("sess-3");
    await handleSessionToolTraces(
      makeEvent("agent.session.tool", {
        sessionId: "sess-3",
        phase: "start",
        toolUseId: "tu-2",
        toolName: "Bash",
        toolKind: "tool",
      }),
      ctx,
    );
    const span = tracer._lastSpan as MockSpan;
    await handleSessionToolTraces(
      makeEvent("agent.session.tool", { sessionId: "sess-3", phase: "end", toolUseId: "tu-2", isError: true }),
      ctx,
    );
    expect(span._status.code).toBe(SpanStatusCode.ERROR);
    expect(span._attributes["error.type"]).toBe("tool_error");
  });

  it("names mcp spans with the server and sets mcp.server.name", async () => {
    const { ctx, tracer } = withSessionSpan("sess-4");
    await handleSessionToolTraces(
      makeEvent("agent.session.tool", {
        sessionId: "sess-4",
        phase: "start",
        toolUseId: "tu-3",
        toolName: "mcp__mempalace__mempalace_search",
        toolKind: "mcp",
        mcpServer: "mempalace",
      }),
      ctx,
    );
    const span = tracer._lastSpan as MockSpan;
    expect(span._attributes["mcp.server.name"]).toBe("mempalace");
    expect(span._attributes["paperclip.tool.kind"]).toBe("mcp");
  });

  it("names skill spans and sets paperclip.skill.name", async () => {
    const { ctx, tracer } = withSessionSpan("sess-5");
    await handleSessionToolTraces(
      makeEvent("agent.session.tool", {
        sessionId: "sess-5",
        phase: "start",
        toolUseId: "tu-4",
        toolName: "Skill",
        toolKind: "skill",
        skillName: "dt-app-dashboards",
      }),
      ctx,
    );
    const span = tracer._lastSpan as MockSpan;
    expect(span._attributes["paperclip.skill.name"]).toBe("dt-app-dashboards");
    expect(span._attributes["paperclip.tool.kind"]).toBe("skill");
  });

  it("ignores an end with no matching start", async () => {
    const { ctx } = withSessionSpan("sess-6");
    await expect(
      handleSessionToolTraces(
        makeEvent("agent.session.tool", { sessionId: "sess-6", phase: "end", toolUseId: "nope", isError: false }),
        ctx,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("handleSessionToolMetrics", () => {
  it("counts only on the end phase", async () => {
    const { ctx, meter } = createTestTelemetryCtx();
    await handleSessionToolMetrics(
      makeEvent("agent.session.tool", { sessionId: "s", phase: "start", toolUseId: "t" }),
      ctx,
    );
    expect(meter._counters.get(METRIC_NAMES.sessionToolExecutions)).toBeUndefined();

    await handleSessionToolMetrics(
      makeEvent("agent.session.tool", { sessionId: "s", phase: "end", toolUseId: "t", isError: true }),
      ctx,
    );
    const counter = meter._counters.get(METRIC_NAMES.sessionToolExecutions);
    expect(counter?.add).toHaveBeenCalledWith(1, expect.objectContaining({ status: "error" }));
  });
});
