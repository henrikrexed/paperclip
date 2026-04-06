/**
 * Observability plugin worker.
 *
 * Subscribes to Paperclip domain events (agent runs, issue lifecycle, cost
 * events, approvals) and forwards them as OTel metrics and traces to a
 * configured OTLP collector.
 */

import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginEvent,
  type PluginHealthDiagnostics,
  type PluginJobContext,
} from "@paperclipai/plugin-sdk";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import type { ObservabilityConfig } from "./constants.js";
import { DEFAULT_CONFIG, JOB_KEYS } from "./constants.js";
import { initOTel, type OTelHandle } from "./otel.js";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let otel: OTelHandle | null = null;
let ctx: PluginContext | null = null;
let startedAt: string | null = null;
let eventsProcessed = 0;
let lastError: string | null = null;

/** In-memory map of active run spans keyed by runId. */
const activeRunSpans = new Map<string, Span>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveConfig(raw: Record<string, unknown>): ObservabilityConfig {
  return {
    otlpEndpoint: (raw.otlpEndpoint as string) ?? DEFAULT_CONFIG.otlpEndpoint,
    otlpProtocol:
      (raw.otlpProtocol as ObservabilityConfig["otlpProtocol"]) ??
      DEFAULT_CONFIG.otlpProtocol,
    serviceName: (raw.serviceName as string) ?? DEFAULT_CONFIG.serviceName,
    metricExportIntervalMs:
      (raw.metricExportIntervalMs as number) ??
      DEFAULT_CONFIG.metricExportIntervalMs,
    traceExportTimeoutMs:
      (raw.traceExportTimeoutMs as number) ??
      DEFAULT_CONFIG.traceExportTimeoutMs,
    enableTracing: (raw.enableTracing as boolean) ?? DEFAULT_CONFIG.enableTracing,
    enableMetrics: (raw.enableMetrics as boolean) ?? DEFAULT_CONFIG.enableMetrics,
    enableLogs: (raw.enableLogs as boolean) ?? DEFAULT_CONFIG.enableLogs,
    resourceAttributes:
      (raw.resourceAttributes as Record<string, string>) ??
      DEFAULT_CONFIG.resourceAttributes,
  };
}

function eventTags(event: PluginEvent<unknown>): Record<string, string> {
  const tags: Record<string, string> = { event_type: event.eventType };
  const p = event.payload as Record<string, unknown> | undefined;
  if (p?.companyId) tags.company_id = String(p.companyId);
  if (p?.projectId) tags.project_id = String(p.projectId);
  if (p?.agentId) tags.agent_id = String(p.agentId);
  return tags;
}

// ---------------------------------------------------------------------------
// Event handlers (all async to satisfy PluginEventHandler signature)
// ---------------------------------------------------------------------------

async function handleAgentRunStarted(event: PluginEvent<unknown>): Promise<void> {
  if (!otel) return;
  eventsProcessed++;

  const p = event.payload as Record<string, unknown>;
  const span = otel.tracer.startSpan("agent.run", {
    attributes: {
      "paperclip.agent.id": String(p.agentId ?? ""),
      "paperclip.run.id": String(p.runId ?? ""),
      "paperclip.company.id": String(p.companyId ?? ""),
      "paperclip.run.invocation_source": String(p.invocationSource ?? ""),
    },
  });

  // Store span in-memory so we can end it on run.finished/failed with correct duration
  const runId = String(p.runId ?? "");
  if (runId) {
    activeRunSpans.set(runId, span);

    // Also persist trace context in plugin state for cross-process correlation
    if (ctx) {
      await ctx.state
        .set(
          { scopeKind: "instance", stateKey: `span:run:${runId}` },
          {
            traceId: span.spanContext().traceId,
            spanId: span.spanContext().spanId,
            startTime: Date.now(),
          },
        )
        .catch(() => {});
    }
  } else {
    // No runId to correlate — end immediately as a point-in-time event
    span.end();
  }
}

async function handleAgentRunFinished(event: PluginEvent<unknown>): Promise<void> {
  if (!otel) return;
  eventsProcessed++;

  const p = event.payload as Record<string, unknown>;
  const runId = String(p.runId ?? "");

  // Record run duration metric
  const durationHist = otel.meter.createHistogram("paperclip.agent.run.duration_ms", {
    description: "Duration of agent heartbeat runs in milliseconds",
    unit: "ms",
  });

  if (p.durationMs != null) {
    durationHist.record(Number(p.durationMs), {
      agent_id: String(p.agentId ?? ""),
      status: "finished",
    });
  }

  // End the run span with success status
  if (runId) {
    const span = activeRunSpans.get(runId);
    if (span) {
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      activeRunSpans.delete(runId);
    }

    // Clean up persisted span state
    if (ctx) {
      await ctx.state
        .delete({ scopeKind: "instance", stateKey: `span:run:${runId}` })
        .catch(() => {});
    }
  }
}

async function handleAgentRunFailed(event: PluginEvent<unknown>): Promise<void> {
  if (!otel) return;
  eventsProcessed++;

  const p = event.payload as Record<string, unknown>;
  const runId = String(p.runId ?? "");

  const errorCounter = otel.meter.createCounter("paperclip.agent.run.errors", {
    description: "Count of failed agent runs",
  });
  errorCounter.add(1, {
    agent_id: String(p.agentId ?? ""),
    error: String(p.error ?? "unknown"),
  });

  // End the run span with error status
  if (runId) {
    const span = activeRunSpans.get(runId);
    if (span) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: String(p.error ?? "unknown"),
      });
      span.end();
      activeRunSpans.delete(runId);
    }

    // Clean up persisted span state
    if (ctx) {
      await ctx.state
        .delete({ scopeKind: "instance", stateKey: `span:run:${runId}` })
        .catch(() => {});
    }
  }
}

async function handleCostEvent(event: PluginEvent<unknown>): Promise<void> {
  if (!otel) return;
  eventsProcessed++;

  const p = event.payload as Record<string, unknown>;

  const inputTokens = otel.meter.createCounter("paperclip.tokens.input", {
    description: "Total input tokens consumed",
  });
  const outputTokens = otel.meter.createCounter("paperclip.tokens.output", {
    description: "Total output tokens consumed",
  });
  const costCounter = otel.meter.createCounter("paperclip.cost.cents", {
    description: "Total cost in cents",
    unit: "cents",
  });

  const tags = {
    agent_id: String(p.agentId ?? ""),
    company_id: String(p.companyId ?? ""),
    model: String(p.model ?? "unknown"),
  };

  if (p.inputTokens != null) inputTokens.add(Number(p.inputTokens), tags);
  if (p.outputTokens != null) outputTokens.add(Number(p.outputTokens), tags);
  if (p.costCents != null) costCounter.add(Number(p.costCents), tags);
}

async function handleIssueUpdated(event: PluginEvent<unknown>): Promise<void> {
  if (!otel) return;
  eventsProcessed++;

  const p = event.payload as Record<string, unknown>;

  const issueTransitions = otel.meter.createCounter(
    "paperclip.issue.transitions",
    { description: "Count of issue status transitions" },
  );
  issueTransitions.add(1, {
    status: String(p.status ?? "unknown"),
    project_id: String(p.projectId ?? ""),
  });
}

async function handleAgentStatusChanged(event: PluginEvent<unknown>): Promise<void> {
  if (!otel) return;
  eventsProcessed++;

  const p = event.payload as Record<string, unknown>;

  const agentStatusChanges = otel.meter.createCounter(
    "paperclip.agent.status_changes",
    { description: "Count of agent status changes" },
  );
  agentStatusChanges.add(1, {
    agent_id: String(p.agentId ?? ""),
    status: String(p.status ?? "unknown"),
  });
}

async function handleApprovalDecided(event: PluginEvent<unknown>): Promise<void> {
  if (!otel) return;
  eventsProcessed++;

  const p = event.payload as Record<string, unknown>;

  const approvalCounter = otel.meter.createCounter(
    "paperclip.approvals.decided",
    { description: "Count of approval decisions" },
  );
  approvalCounter.add(1, {
    decision: String(p.decision ?? "unknown"),
    company_id: String(p.companyId ?? ""),
  });
}

async function handleGenericEvent(event: PluginEvent<unknown>): Promise<void> {
  if (!otel) return;
  eventsProcessed++;

  const genericCounter = otel.meter.createCounter("paperclip.events.total", {
    description: "Total domain events observed",
  });
  genericCounter.add(1, eventTags(event));
}

// ---------------------------------------------------------------------------
// Data handlers for UI bridge
// ---------------------------------------------------------------------------

function registerDataHandlers(pluginCtx: PluginContext): void {
  // Dashboard-level health overview
  pluginCtx.data.register("health-overview", async (params) => {
    const companyId = typeof params.companyId === "string" ? params.companyId : "";
    const agents = companyId
      ? await pluginCtx.agents.list({ companyId, limit: 200, offset: 0 })
      : [];

    const agentSummaries = agents.map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
      lastHeartbeatAt: a.lastHeartbeatAt ? String(a.lastHeartbeatAt) : null,
      budgetMonthlyCents: a.budgetMonthlyCents,
      spentMonthlyCents: a.spentMonthlyCents,
    }));

    return {
      otelInitialised: otel !== null,
      startedAt,
      eventsProcessed,
      lastError,
      agentCount: agents.length,
      agents: agentSummaries,
    };
  });

  // Per-agent health detail for agent detail tab
  pluginCtx.data.register("agent-health", async (params) => {
    const companyId = typeof params.companyId === "string" ? params.companyId : "";
    const agentId = typeof params.agentId === "string" ? params.agentId : "";

    if (!companyId || !agentId) {
      return { error: "Missing companyId or agentId" };
    }

    const agents = await pluginCtx.agents.list({ companyId, limit: 200, offset: 0 });
    const agent = agents.find((a) => a.id === agentId);

    if (!agent) {
      return { error: "Agent not found" };
    }

    const budgetPct = agent.budgetMonthlyCents > 0
      ? Math.round((agent.spentMonthlyCents / agent.budgetMonthlyCents) * 100)
      : 0;

    return {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      role: agent.role,
      title: agent.title ?? "",
      lastHeartbeatAt: agent.lastHeartbeatAt ? String(agent.lastHeartbeatAt) : null,
      budgetMonthlyCents: agent.budgetMonthlyCents,
      spentMonthlyCents: agent.spentMonthlyCents,
      budgetPct,
      otelStatus: otel ? "connected" : lastError ? "degraded" : "disconnected",
      eventsProcessed,
      pluginStartedAt: startedAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: PaperclipPlugin = definePlugin({
  async setup(pluginCtx: PluginContext) {
    ctx = pluginCtx;
    startedAt = new Date().toISOString();
    ctx.logger.info("Observability plugin starting");

    // Load config and initialise OTel SDK
    const rawConfig = await ctx.config.get();
    const config = resolveConfig(rawConfig);

    try {
      otel = initOTel(config);
      ctx.logger.info("OTel SDK initialised", {
        endpoint: config.otlpEndpoint,
        tracing: config.enableTracing,
        metrics: config.enableMetrics,
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      ctx.logger.error("Failed to initialise OTel SDK", { error: lastError });
    }

    // -----------------------------------------------------------------------
    // Subscribe to domain events
    // -----------------------------------------------------------------------

    // Agent run lifecycle
    ctx.events.on("agent.run.started", handleAgentRunStarted);
    ctx.events.on("agent.run.finished", handleAgentRunFinished);
    ctx.events.on("agent.run.failed", handleAgentRunFailed);
    ctx.events.on("agent.run.cancelled", handleGenericEvent);

    // Cost / token events
    ctx.events.on("cost_event.created", handleCostEvent);

    // Issue lifecycle
    ctx.events.on("issue.created", handleGenericEvent);
    ctx.events.on("issue.updated", handleIssueUpdated);

    // Agent status
    ctx.events.on("agent.status_changed", handleAgentStatusChanged);

    // Governance
    ctx.events.on("approval.created", handleGenericEvent);
    ctx.events.on("approval.decided", handleApprovalDecided);

    // Activity
    ctx.events.on("activity.logged", handleGenericEvent);

    // -----------------------------------------------------------------------
    // Register periodic metrics flush job
    // -----------------------------------------------------------------------
    ctx.jobs.register(JOB_KEYS.metricsFlush, async (_job: PluginJobContext) => {
      ctx?.logger.info("Periodic metrics flush triggered");
      await ctx?.activity.log({
        companyId: "",
        message: `OTel metrics flush — ${eventsProcessed} events processed since startup`,
      });
    });

    // -----------------------------------------------------------------------
    // Register data handlers for UI bridge
    // -----------------------------------------------------------------------
    registerDataHandlers(pluginCtx);

    await ctx.activity.log({
      companyId: "",
      message: "Observability plugin initialised and subscribed to domain events",
    });
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    if (!otel) {
      return {
        status: lastError ? "degraded" : "error",
        message: lastError ?? "OTel SDK not initialised",
        details: {
          startedAt,
          eventsProcessed,
          lastError,
        },
      };
    }

    return {
      status: "ok",
      message: `Healthy — ${eventsProcessed} events processed`,
      details: {
        startedAt,
        eventsProcessed,
        otelInitialised: true,
      },
    };
  },

  async onConfigChanged(newConfig: Record<string, unknown>) {
    ctx?.logger.info("Config changed — reinitialising OTel SDK");

    if (otel) {
      try {
        await otel.shutdown();
      } catch (err) {
        ctx?.logger.warn("Error shutting down old OTel SDK", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const config = resolveConfig(newConfig);
    try {
      otel = initOTel(config);
      lastError = null;
      ctx?.logger.info("OTel SDK reinitialised with new config");
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      otel = null;
      ctx?.logger.error("Failed to reinitialise OTel SDK", {
        error: lastError,
      });
    }
  },

  async onValidateConfig(config: Record<string, unknown>) {
    const warnings: string[] = [];
    const errors: string[] = [];

    if (config.otlpEndpoint) {
      const endpoint = String(config.otlpEndpoint);
      if (!endpoint.startsWith("http://") && !endpoint.startsWith("https://")) {
        errors.push("otlpEndpoint must start with http:// or https://");
      }
    }

    if (config.metricExportIntervalMs != null) {
      const interval = Number(config.metricExportIntervalMs);
      if (interval < 1000) {
        warnings.push("metricExportIntervalMs below 1000ms may cause excessive load");
      }
    }

    if (config.serviceName && String(config.serviceName).length > 100) {
      warnings.push("serviceName is unusually long (>100 chars)");
    }

    return { ok: errors.length === 0, warnings, errors };
  },

  async onShutdown() {
    ctx?.logger.info("Observability plugin shutting down — flushing telemetry");

    if (otel) {
      try {
        await otel.shutdown();
        ctx?.logger.info("OTel SDK shut down successfully");
      } catch (err) {
        ctx?.logger.error("Error during OTel shutdown", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      otel = null;
    }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
