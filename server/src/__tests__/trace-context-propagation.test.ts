import { describe, it, expect, afterEach } from "vitest";
import { trace } from "@opentelemetry/api";
import { BatchSpanProcessor, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  withHeartbeatSpan,
  withIssueSpan,
  withConferenceRoomSpan,
  startChildSpan,
  extractTraceContext,
  buildSpanProcessor,
} from "../services/trace-context.js";

describe("server trace-context keystone (ISI-1304)", () => {
  it("returns no trace context when no span is active", () => {
    expect(extractTraceContext()).toBeUndefined();
  });

  it("withHeartbeatSpan establishes an active span whose context is extractable", async () => {
    let inside: ReturnType<typeof extractTraceContext>;
    await withHeartbeatSpan("run-1", "agent-1", { "paperclip.company.id": "co-1" }, async () => {
      inside = extractTraceContext();
    });

    expect(inside).toBeDefined();
    expect(inside?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(inside?.traceId).not.toBe("00000000000000000000000000000000");
    expect(inside?.spanId).toMatch(/^[0-9a-f]{16}$/);

    // Span context must not leak after the heartbeat span ends.
    expect(extractTraceContext()).toBeUndefined();
  });

  it("withIssueSpan nests under the heartbeat span sharing one trace", async () => {
    let heartbeatCtx: ReturnType<typeof extractTraceContext>;
    let issueCtx: ReturnType<typeof extractTraceContext>;

    await withHeartbeatSpan("run-2", "agent-2", {}, async () => {
      heartbeatCtx = extractTraceContext();
      await withIssueSpan("execution", "issue-2", { "paperclip.agent.id": "agent-2" }, async () => {
        issueCtx = extractTraceContext();
      });
    });

    expect(heartbeatCtx).toBeDefined();
    expect(issueCtx).toBeDefined();
    // Same trace, distinct spans → child-parent linkage within one trace tree.
    expect(issueCtx?.traceId).toBe(heartbeatCtx?.traceId);
    expect(issueCtx?.spanId).not.toBe(heartbeatCtx?.spanId);
  });
});

describe("server span export wiring (ISI-1325 R4)", () => {
  const original = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  afterEach(() => {
    if (original === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = original;
  });

  it("exports via a BatchSpanProcessor when an OTLP endpoint is configured", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    expect(buildSpanProcessor()).toBeInstanceOf(BatchSpanProcessor);
  });

  it("discards spans (NoopExporter via SimpleSpanProcessor) when no endpoint is set", () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    expect(buildSpanProcessor()).toBeInstanceOf(SimpleSpanProcessor);
  });

  it("treats a whitespace-only endpoint as unset", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "   ";
    expect(buildSpanProcessor()).toBeInstanceOf(SimpleSpanProcessor);
  });
});

describe("conference-room turn span (ISI-1307)", () => {
  it("withConferenceRoomSpan establishes a root turn span with extractable context", async () => {
    let inside: ReturnType<typeof extractTraceContext>;
    await withConferenceRoomSpan(
      { "paperclip.company.id": "co-1", "conference_room.model": "sonnet" },
      async () => {
        inside = extractTraceContext();
      },
    );

    expect(inside).toBeDefined();
    expect(inside?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(inside?.traceId).not.toBe("00000000000000000000000000000000");
    // Span context must not leak after the turn span ends.
    expect(extractTraceContext()).toBeUndefined();
  });

  it("startChildSpan nests a tool span under the turn span sharing one trace", async () => {
    let turnCtx: ReturnType<typeof extractTraceContext>;
    let toolTraceId = "";
    let toolSpanId = "";

    await withConferenceRoomSpan({ "paperclip.company.id": "co-2" }, async (span) => {
      turnCtx = extractTraceContext();
      const tool = startChildSpan(span, "conference_room.chat.tool", {
        "conference_room.tool.name": "Bash",
      });
      const sc = tool.spanContext();
      toolTraceId = sc.traceId;
      toolSpanId = sc.spanId;
      tool.end();
    });

    expect(turnCtx).toBeDefined();
    // Child tool span shares the turn's trace but is a distinct span.
    expect(toolTraceId).toBe(turnCtx?.traceId);
    expect(toolSpanId).not.toBe(turnCtx?.spanId);
    expect(toolSpanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("startChildSpan parents the tool span on the turn span, not the active root", async () => {
    await withConferenceRoomSpan({ "paperclip.company.id": "co-3" }, async (span) => {
      const tool = startChildSpan(span, "conference_room.chat.tool", {});
      // Active span stays the turn span; the child does not hijack context.
      expect(trace.getActiveSpan()?.spanContext().spanId).toBe(span.spanContext().spanId);
      tool.end();
    });
  });
});
