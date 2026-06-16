/**
 * Session event handlers — agent session lifecycle telemetry.
 *
 * Handles agent session streaming events (create, chunk, status, done, error)
 * to produce OTel spans, metrics, and logs for session observability.
 *
 * Session events are emitted by the server when plugins use ctx.agents.sessions
 * to interact with agents. Each session gets a lifecycle span with child events
 * for chunks and status transitions.
 *
 * Event types handled:
 *   agent.session.created  — start session span, record creation
 *   agent.session.chunk    — record chunk span event with message length
 *   agent.session.status   — record status transition on session span
 *   agent.session.done     — end session span with OK, record duration + TTFT
 *   agent.session.error    — end session span with ERROR, increment error counter
 */

import { SpanKind, SpanStatusCode, trace, context, type Span } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { TelemetryContext } from "./router.js";
import { parentCtxFromServerTrace } from "./trace-utils.js";
import { METRIC_NAMES } from "../constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Per-session metadata for computing TTFT and duration at session end. */
interface SessionMeta {
  startTime: number;
  firstChunkTime: number | null;
  chunkCount: number;
  agentId: string;
  agentName: string;
  companyId: string;
}

const sessionMeta = new Map<string, SessionMeta>();

/**
 * In-flight tool execution spans, keyed by `${sessionId}:${toolUseId}`. A
 * tool_use block (phase "start") opens the span; the matching tool_result
 * block (phase "end") closes it, giving real execution duration and status.
 */
const pendingToolSpans = new Map<string, Span>();

function toolSpanKey(sessionId: string, toolUseId: string): string {
  return `${sessionId}:${toolUseId}`;
}

function emitLog(
  ctx: TelemetryContext,
  severityText: string,
  severityNumber: SeverityNumber,
  body: string,
  attributes: Record<string, string | number | undefined>,
): void {
  if (ctx.otelLogger) {
    ctx.otelLogger.emit({
      severityText,
      severityNumber,
      body,
      attributes,
    });
  }
}

// ---------------------------------------------------------------------------
// agent.session.created — start session lifecycle span
// ---------------------------------------------------------------------------

export async function handleSessionCreatedTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const sessionId = String(p.sessionId ?? "");
  if (!sessionId) return;

  const agentId = String(p.agentId ?? "");
  const agentName = String(p.agentName ?? "");
  const companyId = String(p.companyId ?? event.companyId ?? "");
  const taskKey = String(p.taskKey ?? "");

  const tracer = ctx.getTracerForAgent(agentId, agentName);

  // Parent under active run span if available
  const runId = String(p.runId ?? "");
  const parentSpan = runId ? ctx.activeRunSpans.get(runId) : undefined;
  let parentCtx = parentSpan
    ? trace.setSpan(context.active(), parentSpan)
    : undefined;

  // Fallback: use server-propagated trace context
  if (!parentCtx) {
    parentCtx = parentCtxFromServerTrace(event);
  }

  const span = tracer.startSpan(
    "paperclip.agent.session",
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "paperclip.session.id": sessionId,
        "paperclip.agent.id": agentId,
        "paperclip.company.id": companyId,
        "paperclip.session.task_key": taskKey,
        "gen_ai.operation.name": "session",
        "gen_ai.agent.id": agentId,
        "gen_ai.agent.name": agentName,
      },
    },
    parentCtx,
  );

  ctx.activeSessionSpans.set(sessionId, span);

  sessionMeta.set(sessionId, {
    startTime: Date.now(),
    firstChunkTime: null,
    chunkCount: 0,
    agentId,
    agentName,
    companyId,
  });

  // Persist for cross-restart resilience
  await ctx.state
    .set(
      { scopeKind: "instance", stateKey: `span:session:${sessionId}` },
      {
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        traceFlags: span.spanContext().traceFlags,
        startTime: Date.now(),
      },
    )
    .catch(() => {});
}

export async function handleSessionCreatedMetrics(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  // No dedicated counter for session creation — tracked via span count.
  // This handler is a no-op placeholder for future session creation metrics.
}

export async function handleSessionCreatedLogs(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  emitLog(ctx, "INFO", SeverityNumber.INFO, "Agent session created", {
    "paperclip.session.id": String(p.sessionId ?? ""),
    "paperclip.agent.id": String(p.agentId ?? ""),
    "paperclip.agent.name": String(p.agentName ?? ""),
    "paperclip.company.id": String(p.companyId ?? event.companyId ?? ""),
    "paperclip.event.type": "agent.session.created",
  });
}

// ---------------------------------------------------------------------------
// agent.session.chunk — record chunk as span event, track TTFT
// ---------------------------------------------------------------------------

export async function handleSessionChunkTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const sessionId = String(p.sessionId ?? "");
  if (!sessionId) return;

  const span = ctx.activeSessionSpans.get(sessionId);
  if (!span) return;

  const message = String(p.message ?? "");
  const stream = String(p.stream ?? "stdout");
  const seq = Number(p.seq ?? 0);

  span.addEvent("session.chunk", {
    "paperclip.session.chunk.length": message.length,
    "paperclip.session.chunk.stream": stream,
    "paperclip.session.chunk.seq": seq,
  });

  // Track TTFT and chunk count
  const meta = sessionMeta.get(sessionId);
  if (meta) {
    meta.chunkCount++;
    if (meta.firstChunkTime === null) {
      meta.firstChunkTime = Date.now();
    }
  }
}

export async function handleSessionChunkMetrics(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const sessionId = String(p.sessionId ?? "");

  const meta = sessionMeta.get(sessionId);
  const agentId = meta?.agentId ?? String(p.agentId ?? "");
  const agentName = meta?.agentName ?? String(p.agentName ?? "");

  const chunkCounter = ctx.meter.createCounter(METRIC_NAMES.sessionChunks, {
    description: "Count of streaming chunks received in agent sessions",
  });
  chunkCounter.add(1, {
    agent_id: agentId,
    agent_name: agentName,
    stream: String(p.stream ?? "stdout"),
  });
}

// ---------------------------------------------------------------------------
// agent.session.chat — per-turn LLM chat span (OTel GenAI semconv)
// ---------------------------------------------------------------------------

export async function handleSessionChatTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const sessionId = String(p.sessionId ?? "");
  if (!sessionId) return;

  const parentSpan = ctx.activeSessionSpans.get(sessionId);
  if (!parentSpan) return;

  const model = String(p.model ?? "unknown");
  const inputTokens = Number(p.inputTokens ?? 0);
  const outputTokens = Number(p.outputTokens ?? 0);
  const cachedInputTokens = Number(p.cachedInputTokens ?? 0);
  const stopReason = p.stopReason != null ? String(p.stopReason) : undefined;

  const agentId = String(p.agentId ?? "");
  const agentName = String(p.agentName ?? "");
  const tracer = ctx.getTracerForAgent(agentId, agentName);
  const parentCtx = trace.setSpan(context.active(), parentSpan);

  // Discrete stream-json lines do not expose per-turn start/end timestamps, so
  // the chat turn is modelled as a point-in-time span: it captures the model
  // and token usage for visibility, nested under the session span.
  const span = tracer.startSpan(
    `chat ${model}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "paperclip.session.id": sessionId,
        "gen_ai.operation.name": "chat",
        "gen_ai.system": "anthropic",
        "gen_ai.request.model": model,
        "gen_ai.response.model": model,
        "gen_ai.usage.input_tokens": inputTokens,
        "gen_ai.usage.output_tokens": outputTokens,
        "gen_ai.usage.cached_input_tokens": cachedInputTokens,
        ...(stopReason ? { "gen_ai.response.finish_reasons": stopReason } : {}),
      },
    },
    parentCtx,
  );
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

export async function handleSessionChatMetrics(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const meta = sessionMeta.get(String(p.sessionId ?? ""));
  const chatCounter = ctx.meter.createCounter(METRIC_NAMES.sessionChatTurns, {
    description: "Count of LLM chat turns observed in agent sessions",
  });
  chatCounter.add(1, {
    agent_id: meta?.agentId ?? String(p.agentId ?? ""),
    agent_name: meta?.agentName ?? String(p.agentName ?? ""),
    model: String(p.model ?? "unknown"),
  });
}

// ---------------------------------------------------------------------------
// agent.session.tool — tool / MCP / skill execution spans
// ---------------------------------------------------------------------------

export async function handleSessionToolTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const sessionId = String(p.sessionId ?? "");
  const toolUseId = String(p.toolUseId ?? "");
  if (!sessionId || !toolUseId) return;

  const phase = String(p.phase ?? "");
  const key = toolSpanKey(sessionId, toolUseId);

  if (phase === "start") {
    const parentSpan = ctx.activeSessionSpans.get(sessionId);
    if (!parentSpan) return;

    const toolName = String(p.toolName ?? "unknown");
    const toolKind = String(p.toolKind ?? "tool");
    const mcpServer = p.mcpServer != null ? String(p.mcpServer) : undefined;
    const skillName = p.skillName != null ? String(p.skillName) : undefined;

    const agentId = String(p.agentId ?? "");
    const agentName = String(p.agentName ?? "");
    const tracer = ctx.getTracerForAgent(agentId, agentName);
    const parentCtx = trace.setSpan(context.active(), parentSpan);

    const spanName =
      toolKind === "mcp"
        ? `mcp ${mcpServer ?? toolName}`
        : toolKind === "skill"
          ? `skill ${skillName ?? toolName}`
          : `execute_tool ${toolName}`;

    const attributes: Record<string, string> = {
      "paperclip.session.id": sessionId,
      "paperclip.tool.kind": toolKind,
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": toolName,
    };
    if (toolKind === "mcp" && mcpServer) attributes["mcp.server.name"] = mcpServer;
    if (toolKind === "skill" && skillName) attributes["paperclip.skill.name"] = skillName;

    const span = tracer.startSpan(
      spanName,
      { kind: SpanKind.INTERNAL, attributes },
      parentCtx,
    );
    pendingToolSpans.set(key, span);
    return;
  }

  if (phase === "end") {
    const span = pendingToolSpans.get(key);
    if (!span) return;
    const isError = p.isError === true;
    if (isError) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "tool_error" });
      span.setAttribute("error.type", "tool_error");
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
    pendingToolSpans.delete(key);
  }
}

export async function handleSessionToolMetrics(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  if (String(p.phase ?? "") !== "end") return;

  const meta = sessionMeta.get(String(p.sessionId ?? ""));
  const toolCounter = ctx.meter.createCounter(METRIC_NAMES.sessionToolExecutions, {
    description: "Count of tool/MCP/skill executions observed in agent sessions",
  });
  toolCounter.add(1, {
    agent_id: meta?.agentId ?? String(p.agentId ?? ""),
    agent_name: meta?.agentName ?? String(p.agentName ?? ""),
    status: p.isError === true ? "error" : "ok",
  });
}

// ---------------------------------------------------------------------------
// agent.session.status — record status transition on session span
// ---------------------------------------------------------------------------

export async function handleSessionStatusTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const sessionId = String(p.sessionId ?? "");
  if (!sessionId) return;

  const span = ctx.activeSessionSpans.get(sessionId);
  if (!span) return;

  const status = String(p.status ?? "unknown");

  span.addEvent("session.status", {
    "paperclip.session.status": status,
  });
}

// ---------------------------------------------------------------------------
// agent.session.done — end session span with OK, record duration + TTFT
// ---------------------------------------------------------------------------

export async function handleSessionDoneTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const sessionId = String(p.sessionId ?? "");
  if (!sessionId) return;

  let span = ctx.activeSessionSpans.get(sessionId);

  // Fallback: restore from plugin state
  if (!span) {
    const stored = await ctx.state
      .get({ scopeKind: "instance", stateKey: `span:session:${sessionId}` })
      .catch(() => null);
    if (
      stored &&
      typeof stored === "object" &&
      "traceId" in (stored as Record<string, unknown>)
    ) {
      const s = stored as { traceId: string; spanId: string; traceFlags: number };
      const restoredCtx = trace.setSpanContext(context.active(), {
        traceId: s.traceId,
        spanId: s.spanId,
        traceFlags: s.traceFlags ?? 1,
        isRemote: true,
      });
      const agentId = String(p.agentId ?? "");
      const agentName = String(p.agentName ?? "");
      const tracer = ctx.getTracerForAgent(agentId, agentName);
      span = tracer.startSpan(
        "paperclip.agent.session.end",
        {
          kind: SpanKind.INTERNAL,
          attributes: { "paperclip.session.id": sessionId },
        },
        restoredCtx,
      );
    }
  }

  if (span) {
    const meta = sessionMeta.get(sessionId);
    if (meta) {
      span.setAttribute("paperclip.session.chunk_count", meta.chunkCount);
    }
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    ctx.activeSessionSpans.delete(sessionId);
  }

  await ctx.state
    .delete({ scopeKind: "instance", stateKey: `span:session:${sessionId}` })
    .catch(() => {});
  sessionMeta.delete(sessionId);
}

export async function handleSessionDoneMetrics(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const sessionId = String(p.sessionId ?? "");

  const meta = sessionMeta.get(sessionId);
  if (!meta) return;

  const now = Date.now();
  const durationMs = now - meta.startTime;
  const attrs = {
    agent_id: meta.agentId,
    agent_name: meta.agentName,
  };

  // Session duration histogram
  const durationHist = ctx.meter.createHistogram(METRIC_NAMES.sessionDuration, {
    description: "Agent session duration in milliseconds",
    unit: "ms",
  });
  durationHist.record(durationMs, attrs);

  // Time to first token histogram
  if (meta.firstChunkTime !== null) {
    const ttftMs = meta.firstChunkTime - meta.startTime;
    const ttftHist = ctx.meter.createHistogram(METRIC_NAMES.sessionTtft, {
      description: "Time to first token in agent sessions",
      unit: "ms",
    });
    ttftHist.record(ttftMs, attrs);
  }
}

export async function handleSessionDoneLogs(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const sessionId = String(p.sessionId ?? "");
  const meta = sessionMeta.get(sessionId);

  emitLog(ctx, "INFO", SeverityNumber.INFO, "Agent session completed", {
    "paperclip.session.id": sessionId,
    "paperclip.agent.id": meta?.agentId ?? String(p.agentId ?? ""),
    "paperclip.agent.name": meta?.agentName ?? String(p.agentName ?? ""),
    "paperclip.company.id": meta?.companyId ?? String(p.companyId ?? event.companyId ?? ""),
    "paperclip.session.chunk_count": meta?.chunkCount ?? 0,
    "paperclip.event.type": "agent.session.done",
  });
}

// ---------------------------------------------------------------------------
// agent.session.error — end session span with ERROR, increment error counter
// ---------------------------------------------------------------------------

export async function handleSessionErrorTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const sessionId = String(p.sessionId ?? "");
  if (!sessionId) return;

  let span = ctx.activeSessionSpans.get(sessionId);

  // Fallback: restore from plugin state
  if (!span) {
    const stored = await ctx.state
      .get({ scopeKind: "instance", stateKey: `span:session:${sessionId}` })
      .catch(() => null);
    if (
      stored &&
      typeof stored === "object" &&
      "traceId" in (stored as Record<string, unknown>)
    ) {
      const s = stored as { traceId: string; spanId: string; traceFlags: number };
      const restoredCtx = trace.setSpanContext(context.active(), {
        traceId: s.traceId,
        spanId: s.spanId,
        traceFlags: s.traceFlags ?? 1,
        isRemote: true,
      });
      const agentId = String(p.agentId ?? "");
      const agentName = String(p.agentName ?? "");
      const tracer = ctx.getTracerForAgent(agentId, agentName);
      span = tracer.startSpan(
        "paperclip.agent.session.error",
        {
          kind: SpanKind.INTERNAL,
          attributes: { "paperclip.session.id": sessionId },
        },
        restoredCtx,
      );
    }
  }

  if (span) {
    const errorMsg = String(p.error ?? p.message ?? "unknown session error");
    span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
    span.setAttribute("error.type", "session_error");
    span.recordException(new Error(errorMsg));

    const meta = sessionMeta.get(sessionId);
    if (meta) {
      span.setAttribute("paperclip.session.chunk_count", meta.chunkCount);
    }
    span.end();
    ctx.activeSessionSpans.delete(sessionId);
  }

  await ctx.state
    .delete({ scopeKind: "instance", stateKey: `span:session:${sessionId}` })
    .catch(() => {});
  sessionMeta.delete(sessionId);
}

export async function handleSessionErrorMetrics(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const sessionId = String(p.sessionId ?? "");

  const meta = sessionMeta.get(sessionId);
  const agentId = meta?.agentId ?? String(p.agentId ?? "");
  const agentName = meta?.agentName ?? String(p.agentName ?? "");

  const errorCounter = ctx.meter.createCounter(METRIC_NAMES.sessionErrors, {
    description: "Count of agent session errors",
  });
  errorCounter.add(1, {
    agent_id: agentId,
    agent_name: agentName,
  });
}

export async function handleSessionErrorLogs(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const sessionId = String(p.sessionId ?? "");
  const meta = sessionMeta.get(sessionId);
  const errorMsg = String(p.error ?? p.message ?? "unknown");

  emitLog(ctx, "ERROR", SeverityNumber.ERROR, `Agent session error: ${errorMsg}`, {
    "paperclip.session.id": sessionId,
    "paperclip.agent.id": meta?.agentId ?? String(p.agentId ?? ""),
    "paperclip.agent.name": meta?.agentName ?? String(p.agentName ?? ""),
    "paperclip.company.id": meta?.companyId ?? String(p.companyId ?? event.companyId ?? ""),
    "paperclip.event.type": "agent.session.error",
    "error.message": errorMsg,
  });
}
