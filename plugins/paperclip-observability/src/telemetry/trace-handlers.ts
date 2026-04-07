/**
 * Trace event handlers — span lifecycle management.
 *
 * Each handler creates, updates, or ends OTel spans in response to Paperclip
 * domain events. Span references are stored in TelemetryContext maps and
 * persisted to plugin state for cross-restart resilience.
 */

import {
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  type Context,
} from "@opentelemetry/api";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { TelemetryContext } from "./router.js";
import { mapProvider } from "../provider-map.js";
import { METRIC_NAMES } from "../constants.js";

// ---------------------------------------------------------------------------
// W3C Trace Context helpers
// ---------------------------------------------------------------------------

/**
 * Parse W3C `traceparent` header and return an OTel Context with the remote
 * span context set. Returns `undefined` when the header is missing or invalid.
 *
 * Format: `version-traceId-spanId-traceFlags` (e.g. `"00-abc...def-0123...89ab-01"`)
 *
 * @see https://www.w3.org/TR/trace-context/#traceparent-header
 */
function extractTraceContext(event: PluginEvent): Context | undefined {
  const tc = event.traceContext;
  if (!tc?.traceparent) return undefined;

  const parts = tc.traceparent.split("-");
  if (parts.length < 4) return undefined;

  const [, traceId, spanId, flagsHex] = parts;
  if (!traceId || traceId.length !== 32 || !spanId || spanId.length !== 16) {
    return undefined;
  }

  const traceFlags = parseInt(flagsHex, 16);
  if (Number.isNaN(traceFlags)) return undefined;

  return trace.setSpanContext(context.active(), {
    traceId,
    spanId,
    traceFlags,
    isRemote: true,
  });
}

// ---------------------------------------------------------------------------
// agent.run.started — create run span (child of issue span when available)
// ---------------------------------------------------------------------------

export async function handleRunStartedTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const runId = String(p.runId ?? "");
  const issueId = String(p.issueId ?? "");

  const agentId = String(p.agentId ?? "");
  // Resolve display name: prefer agentNameMap lookup, fall back to payload
  const agentName = (agentId && ctx.agentNameMap.get(agentId)) || String(p.agentName ?? "");

  // Resolve business context from agentIssueMap (primary) or issueContextMap (fallback)
  const agentIssue = ctx.agentIssueMap.get(agentId);
  const resolvedIssueId = issueId || agentIssue?.issueId || "";
  const issueCtx = resolvedIssueId ? ctx.issueContextMap.get(resolvedIssueId) : undefined;
  const issueIdentifier = agentIssue?.issueIdentifier || issueCtx?.identifier || "";
  const issueTitle = issueCtx?.title || "";
  const projectId = agentIssue?.projectId || issueCtx?.projectId || "";
  const projectName = projectId ? (ctx.projectNameMap.get(projectId) ?? "") : "";

  const spanAttrs: Record<string, string | number | boolean> = {
    "paperclip.agent.id": agentId,
    "paperclip.agent.name": agentName,
    "paperclip.run.id": runId,
    "paperclip.company.id": String(p.companyId ?? event.companyId ?? ""),
    "paperclip.run.invocation_source": String(p.invocationSource ?? ""),
    "paperclip.run.trigger_detail": String(p.triggerDetail ?? ""),
    "paperclip.issue.id": resolvedIssueId,
    "paperclip.issue.identifier": issueIdentifier,
    "paperclip.issue.title": issueTitle,
    "paperclip.project.id": projectId,
    "paperclip.project.name": projectName,
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.id": agentId,
    "gen_ai.agent.name": agentName,
  };

  // Use per-agent tracer so this agent gets its own service.name
  const tracer = ctx.getTracerForAgent(agentId, agentName);

  // Try to parent under the issue execution span for cross-agent context
  let parentCtx = resolvedIssueId
    ? resolveParentContext(ctx, resolvedIssueId)
    : undefined;

  // Fallback: use W3C Trace Context from the event envelope
  if (!parentCtx) {
    parentCtx = extractTraceContext(event);
  }

  // Fallback: restore from plugin state if not in memory
  if (!parentCtx && resolvedIssueId) {
    const stored = await ctx.state
      .get({ scopeKind: "issue", scopeId: resolvedIssueId, stateKey: "execution-span" })
      .catch(() => null);
    if (
      stored &&
      typeof stored === "object" &&
      "traceId" in (stored as Record<string, unknown>) &&
      "spanId" in (stored as Record<string, unknown>)
    ) {
      const s = stored as { traceId: string; spanId: string; traceFlags: number };
      parentCtx = trace.setSpanContext(context.active(), {
        traceId: s.traceId,
        spanId: s.spanId,
        traceFlags: s.traceFlags ?? 1,
        isRemote: true,
      });
    }
  }

  const span = parentCtx
    ? tracer.startSpan(
        "paperclip.heartbeat.run",
        { kind: SpanKind.INTERNAL, attributes: spanAttrs },
        parentCtx,
      )
    : tracer.startSpan("paperclip.heartbeat.run", {
        kind: SpanKind.INTERNAL,
        attributes: spanAttrs,
      });

  if (runId) {
    ctx.activeRunSpans.set(runId, span);

    // Push trace context to event bus so subsequent server-emitted events
    // (e.g. cost_event.created) carry the correct W3C trace context.
    const sc = span.spanContext();
    const flags = sc.traceFlags.toString(16).padStart(2, "0");
    ctx.pushTraceContext(`run:${runId}`, {
      traceparent: `00-${sc.traceId}-${sc.spanId}-${flags}`,
    });

    await ctx.state
      .set(
        { scopeKind: "instance", stateKey: `span:run:${runId}` },
        {
          traceId: sc.traceId,
          spanId: sc.spanId,
          traceFlags: sc.traceFlags,
          startTime: Date.now(),
        },
      )
      .catch(() => {});
  } else {
    span.end();
  }
}

/**
 * Resolve a parent OTel context from an active issue span.
 * Returns undefined when no in-memory span exists for the issue.
 */
function resolveParentContext(
  ctx: TelemetryContext,
  issueId: string,
) {
  const issueSpan = ctx.activeIssueSpans.get(issueId);
  return issueSpan
    ? trace.setSpan(context.active(), issueSpan)
    : undefined;
}

// ---------------------------------------------------------------------------
// agent.run.finished — end root run span with OK
// ---------------------------------------------------------------------------

export async function handleRunFinishedTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const runId = String(p.runId ?? "");
  if (!runId) return;

  const span = ctx.activeRunSpans.get(runId);
  if (span) {
    if (p.exitCode != null) {
      span.setAttribute("paperclip.run.exit_code", Number(p.exitCode));
    }
    if (p.durationMs != null) {
      span.setAttribute("paperclip.run.duration_ms", Number(p.durationMs));
    }
    if (p.issueId) {
      span.setAttribute("paperclip.issue.id", String(p.issueId));
    }
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    ctx.activeRunSpans.delete(runId);
  }

  ctx.clearTraceContext(`run:${runId}`);
  await ctx.state
    .delete({ scopeKind: "instance", stateKey: `span:run:${runId}` })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// agent.run.failed — end root run span with ERROR
// ---------------------------------------------------------------------------

export async function handleRunFailedTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const runId = String(p.runId ?? "");
  if (!runId) return;

  const span = ctx.activeRunSpans.get(runId);
  if (span) {
    const errorMsg = String(p.error ?? "unknown");
    span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
    span.setAttribute("error.type", String(p.errorCode ?? "run_failed"));
    if (p.exitCode != null) {
      span.setAttribute("paperclip.run.exit_code", Number(p.exitCode));
    }
    if (p.stderrExcerpt) {
      span.setAttribute(
        "paperclip.run.stderr_excerpt",
        String(p.stderrExcerpt),
      );
    }
    span.recordException(new Error(errorMsg));
    span.end();
    ctx.activeRunSpans.delete(runId);
  }

  ctx.clearTraceContext(`run:${runId}`);
  await ctx.state
    .delete({ scopeKind: "instance", stateKey: `span:run:${runId}` })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// agent.run.cancelled — end root run span
// ---------------------------------------------------------------------------

export async function handleRunCancelledTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const runId = String(p.runId ?? "");
  if (!runId) return;

  const span = ctx.activeRunSpans.get(runId);
  if (span) {
    span.setStatus({ code: SpanStatusCode.OK, message: "cancelled" });
    span.setAttribute("paperclip.run.cancelled", true);
    span.end();
    ctx.activeRunSpans.delete(runId);
  }

  ctx.clearTraceContext(`run:${runId}`);
  await ctx.state
    .delete({ scopeKind: "instance", stateKey: `span:run:${runId}` })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// cost_event.created — LLM child span
// ---------------------------------------------------------------------------

export async function handleCostTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const agentId = String(p.agentId ?? "");
  const agentName = (agentId && ctx.agentNameMap.get(agentId)) || String(p.agentName ?? "");
  const provider = mapProvider(String(p.provider ?? ""));
  const model = String(p.model ?? "unknown");
  const spanName = `chat ${model}`;

  // Use per-agent tracer so cost spans appear under the correct service
  const tracer = ctx.getTracerForAgent(agentId, agentName);

  // Resolve business context from agent's active issue
  const agentIssue = ctx.agentIssueMap.get(agentId);
  const costIssueId = agentIssue?.issueId || "";
  const costIssueCtx = costIssueId ? ctx.issueContextMap.get(costIssueId) : undefined;
  const costIssueIdentifier = agentIssue?.issueIdentifier || costIssueCtx?.identifier || "";
  const costIssueTitle = costIssueCtx?.title || "";
  const costProjectId = agentIssue?.projectId || costIssueCtx?.projectId || "";
  const costProjectName = costProjectId ? (ctx.projectNameMap.get(costProjectId) ?? "") : "";

  const llmSpanAttrs: Record<string, string | number | boolean> = {
    "paperclip.agent.id": agentId,
    "paperclip.agent.name": agentName,
    "paperclip.company.id": String(p.companyId ?? ""),
    "paperclip.cost.cents": Number(p.costCents ?? 0),
    "paperclip.billing.type": String(p.billingType ?? ""),
    "paperclip.billing.biller": String(p.biller ?? ""),
    "paperclip.issue.id": costIssueId,
    "paperclip.issue.identifier": costIssueIdentifier,
    "paperclip.issue.title": costIssueTitle,
    "paperclip.project.id": costProjectId,
    "paperclip.project.name": costProjectName,
    "gen_ai.operation.name": "chat",
    "gen_ai.agent.id": agentId,
    "gen_ai.agent.name": agentName,
    "gen_ai.provider.name": provider,
    "gen_ai.request.model": model,
    "gen_ai.usage.input_tokens": Number(p.inputTokens ?? 0),
    "gen_ai.usage.output_tokens": Number(p.outputTokens ?? 0),
    "gen_ai.usage.cache_read.input_tokens": Number(
      p.cachedInputTokens ?? 0,
    ),
  };

  // If this cost event belongs to an active run, create as a child span.
  const heartbeatRunId = String(p.heartbeatRunId ?? "");
  let parentSpan = heartbeatRunId
    ? ctx.activeRunSpans.get(heartbeatRunId)
    : undefined;

  let parentCtx = parentSpan
    ? trace.setSpan(context.active(), parentSpan)
    : undefined;

  // Fallback: use W3C Trace Context from the event envelope
  if (!parentCtx) {
    parentCtx = extractTraceContext(event);
  }

  // Fallback: restore parent context from plugin state if not in memory
  if (!parentCtx && heartbeatRunId) {
    const stored = await ctx.state
      .get({ scopeKind: "instance", stateKey: `span:run:${heartbeatRunId}` })
      .catch(() => null);
    if (
      stored &&
      typeof stored === "object" &&
      "traceId" in (stored as Record<string, unknown>) &&
      "spanId" in (stored as Record<string, unknown>)
    ) {
      const s = stored as {
        traceId: string;
        spanId: string;
        traceFlags: number;
      };
      const restoredSpanCtx = {
        traceId: s.traceId,
        spanId: s.spanId,
        traceFlags: s.traceFlags ?? 1,
        isRemote: true,
      };
      parentCtx = trace.setSpanContext(context.active(), restoredSpanCtx);
    }
  }

  const span = parentCtx
    ? tracer.startSpan(
        spanName,
        { kind: SpanKind.CLIENT, attributes: llmSpanAttrs },
        parentCtx,
      )
    : tracer.startSpan(spanName, {
        kind: SpanKind.CLIENT,
        attributes: llmSpanAttrs,
      });

  span.end();
}

// ---------------------------------------------------------------------------
// issue.updated — issue lifecycle spans
// ---------------------------------------------------------------------------

export async function handleIssueUpdatedTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const status = String(p.status ?? "unknown");
  const prev = p._previous as Record<string, unknown> | undefined;
  const previousStatus = String(p.previousStatus ?? prev?.status ?? "");
  const issueId = String(p.id ?? event.entityId ?? "");
  const assigneeAgentId = String(p.assigneeAgentId ?? "");
  // Resolve display name: prefer agentNameMap lookup, fall back to payload fields
  const assigneeAgentName = (assigneeAgentId && ctx.agentNameMap.get(assigneeAgentId))
    || String(p.assigneeAgentName ?? p.executionAgentNameKey ?? "");

  // Use per-agent tracer when an assignee is known
  const tracer = assigneeAgentId
    ? ctx.getTracerForAgent(assigneeAgentId, assigneeAgentName)
    : ctx.tracer;

  // Start span when issue transitions to in_progress
  if (status === "in_progress" && previousStatus !== "in_progress" && issueId) {
    const projectId = String(p.projectId ?? "");
    const projectName = ctx.projectNameMap.get(projectId) ?? "";
    const identifier = String(p.identifier ?? "");
    const title = String(p.title ?? "");

    const span = tracer.startSpan("paperclip.issue.execution", {
      kind: SpanKind.INTERNAL,
      attributes: {
        "paperclip.issue.id": issueId,
        "paperclip.issue.identifier": identifier,
        "paperclip.issue.title": title,
        "paperclip.issue.priority": String(p.priority ?? "medium"),
        "paperclip.issue.status": status,
        "paperclip.project.id": projectId,
        "paperclip.project.name": projectName,
        "paperclip.goal.id": String(p.goalId ?? ""),
        "paperclip.agent.name": assigneeAgentName,
        "gen_ai.agent.id": assigneeAgentId,
        "gen_ai.agent.name": assigneeAgentName,
      },
    });

    // Populate agentIssueMap so run/cost spans can look up business context
    if (assigneeAgentId) {
      ctx.agentIssueMap.set(assigneeAgentId, {
        issueId,
        issueIdentifier: identifier,
        projectId,
      });
    }

    ctx.activeIssueSpans.set(issueId, span);

    // Push trace context to event bus for issue-scoped events
    const sc = span.spanContext();
    const flags = sc.traceFlags.toString(16).padStart(2, "0");
    ctx.pushTraceContext(`issue:${issueId}`, {
      traceparent: `00-${sc.traceId}-${sc.spanId}-${flags}`,
    });

    await ctx.state
      .set(
        { scopeKind: "issue", scopeId: issueId, stateKey: "execution-span" },
        {
          traceId: sc.traceId,
          spanId: sc.spanId,
          traceFlags: sc.traceFlags,
          startTime: Date.now(),
        },
      )
      .catch(() => {});
  }

  // Clean up agentIssueMap when issue leaves in_progress
  if (status !== "in_progress" && assigneeAgentId) {
    const mapped = ctx.agentIssueMap.get(assigneeAgentId);
    if (mapped && mapped.issueId === issueId) {
      ctx.agentIssueMap.delete(assigneeAgentId);
    }
  }

  // End span when issue transitions to done or cancelled
  if ((status === "done" || status === "cancelled") && issueId) {
    let span = ctx.activeIssueSpans.get(issueId);

    // Fallback: restore from plugin state if not in memory
    if (!span) {
      const stored = await ctx.state
        .get({
          scopeKind: "issue",
          scopeId: issueId,
          stateKey: "execution-span",
        })
        .catch(() => null);
      if (
        stored &&
        typeof stored === "object" &&
        "traceId" in (stored as Record<string, unknown>)
      ) {
        const s = stored as {
          traceId: string;
          spanId: string;
          traceFlags: number;
          startTime: number;
        };
        const restoredCtx = trace.setSpanContext(context.active(), {
          traceId: s.traceId,
          spanId: s.spanId,
          traceFlags: s.traceFlags ?? 1,
          isRemote: true,
        });
        span = tracer.startSpan(
          "paperclip.issue.execution.end",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              "paperclip.issue.id": issueId,
              "paperclip.issue.identifier": String(p.identifier ?? ""),
              "paperclip.issue.status": status,
            },
          },
          restoredCtx,
        );
      }
    }

    if (span) {
      span.setAttribute("paperclip.issue.status", status);
      if (status === "done") {
        span.setStatus({ code: SpanStatusCode.OK });
      } else {
        span.setStatus({ code: SpanStatusCode.UNSET });
        span.setAttribute("paperclip.issue.cancelled", true);
      }
      span.end();
      ctx.activeIssueSpans.delete(issueId);
    }

    ctx.clearTraceContext(`issue:${issueId}`);
    await ctx.state
      .delete({
        scopeKind: "issue",
        scopeId: issueId,
        stateKey: "execution-span",
      })
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// approval.created — start approval lifecycle span
// ---------------------------------------------------------------------------

export async function handleApprovalCreatedTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const approvalId = String(p.id ?? "");
  if (!approvalId) return;

  const companyId = String(p.companyId ?? event.companyId ?? "");
  const requestingAgentId = String(p.requestingAgentId ?? "");
  const requestingAgentName = String(p.requestingAgentName ?? "");
  const approvalType = String(p.approvalType ?? p.type ?? "unknown");

  const span = ctx.tracer.startSpan("paperclip.approval.lifecycle", {
    kind: SpanKind.INTERNAL,
    attributes: {
      "paperclip.approval.id": approvalId,
      "paperclip.company.id": companyId,
      "paperclip.approval.type": approvalType,
      "paperclip.approval.requesting_agent.id": requestingAgentId,
      "paperclip.approval.requesting_agent.name": requestingAgentName,
    },
  });

  ctx.activeApprovalSpans.set(approvalId, span);

  // Persist span context for cross-restart resilience
  await ctx.state
    .set(
      { scopeKind: "instance", stateKey: `span:approval:${approvalId}` },
      {
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        traceFlags: span.spanContext().traceFlags,
        startTime: Date.now(),
      },
    )
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// approval.decided — end approval lifecycle span with decision + latency
// ---------------------------------------------------------------------------

export async function handleApprovalDecidedTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const approvalId = String(p.id ?? "");
  if (!approvalId) return;

  const decision = String(p.decision ?? "unknown");
  const approverAgentId = String(p.approverAgentId ?? p.decidedByAgentId ?? "");
  const approverUserId = String(p.approverUserId ?? p.decidedByUserId ?? "");

  let span = ctx.activeApprovalSpans.get(approvalId);
  let startTime: number | null = null;

  // Fallback: restore from plugin state if not in memory
  if (!span) {
    const stored = await ctx.state
      .get({ scopeKind: "instance", stateKey: `span:approval:${approvalId}` })
      .catch(() => null);
    if (
      stored &&
      typeof stored === "object" &&
      "traceId" in (stored as Record<string, unknown>) &&
      "spanId" in (stored as Record<string, unknown>)
    ) {
      const s = stored as {
        traceId: string;
        spanId: string;
        traceFlags: number;
        startTime: number;
      };
      startTime = s.startTime ?? null;
      const restoredCtx = trace.setSpanContext(context.active(), {
        traceId: s.traceId,
        spanId: s.spanId,
        traceFlags: s.traceFlags ?? 1,
        isRemote: true,
      });
      span = ctx.tracer.startSpan(
        "paperclip.approval.decision",
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            "paperclip.approval.id": approvalId,
            "paperclip.approval.decision": decision,
          },
        },
        restoredCtx,
      );
    }
  }

  if (span) {
    span.setAttribute("paperclip.approval.decision", decision);
    span.setAttribute("paperclip.approval.approver.agent_id", approverAgentId);
    span.setAttribute("paperclip.approval.approver.user_id", approverUserId);

    // Compute decision latency from stored start time
    if (!startTime) {
      const stored = await ctx.state
        .get({ scopeKind: "instance", stateKey: `span:approval:${approvalId}` })
        .catch(() => null);
      if (stored && typeof stored === "object" && "startTime" in (stored as Record<string, unknown>)) {
        startTime = (stored as { startTime: number }).startTime;
      }
    }

    if (startTime) {
      const decisionTimeMs = Date.now() - startTime;
      span.setAttribute("paperclip.approval.decision_time_ms", decisionTimeMs);

      // Record decision latency histogram
      const histogram = ctx.meter.createHistogram(
        METRIC_NAMES.approvalDecisionTime,
        { description: "Approval decision latency in milliseconds", unit: "ms" },
      );
      histogram.record(decisionTimeMs, {
        decision,
        company_id: String(p.companyId ?? ""),
      });
    }

    if (decision === "approved") {
      span.setStatus({ code: SpanStatusCode.OK });
    } else if (decision === "rejected") {
      span.setStatus({ code: SpanStatusCode.OK, message: "rejected" });
    } else {
      span.setStatus({ code: SpanStatusCode.UNSET });
    }

    span.end();
    ctx.activeApprovalSpans.delete(approvalId);
  }

  // Clean up persisted state
  await ctx.state
    .delete({ scopeKind: "instance", stateKey: `span:approval:${approvalId}` })
    .catch(() => {});
}
