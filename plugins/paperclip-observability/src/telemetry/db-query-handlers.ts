/**
 * Database query event handlers — trace spans and metrics for DB operations.
 *
 * Handles `db.query.completed` events emitted by the server's DB
 * instrumentation layer. Creates child spans under the active run span
 * and records duration histograms for database call latency.
 */

import { SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { TelemetryContext } from "./router.js";
import { parentCtxFromServerTrace } from "./trace-utils.js";
import { METRIC_NAMES } from "../constants.js";

// ---------------------------------------------------------------------------
// db.query.completed — trace handler (child span of active run)
// ---------------------------------------------------------------------------

export async function handleDbQueryTraces(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const operation = String(p.operation ?? "unknown");
  const table = String(p.table ?? "unknown");
  const durationMs = Number(p.durationMs ?? 0);
  const description = p.description ? String(p.description) : undefined;
  const rowCount = p.rowCount != null ? Number(p.rowCount) : undefined;
  const error = p.error ? String(p.error) : undefined;
  const agentId = String(p.agentId ?? "");
  const runId = String(p.runId ?? "");

  const spanName = `db.${operation} ${table}`;

  const spanAttrs: Record<string, string | number | boolean> = {
    "db.system": "postgresql",
    "db.operation": operation,
    "db.sql.table": table,
    "db.query.duration_ms": durationMs,
  };
  if (description) spanAttrs["db.query.summary"] = description;
  if (rowCount !== undefined) spanAttrs["db.response.rows"] = rowCount;
  if (agentId) spanAttrs["paperclip.agent.id"] = agentId;
  if (runId) spanAttrs["paperclip.run.id"] = runId;

  // Resolve parent context: server trace > active run span
  let parentCtx = parentCtxFromServerTrace(event);

  if (!parentCtx && runId) {
    const runSpan = ctx.activeRunSpans.get(runId);
    if (runSpan) {
      parentCtx = trace.setSpan(context.active(), runSpan);
    }
  }

  const tracer = ctx.tracer;
  const span = parentCtx
    ? tracer.startSpan(spanName, { kind: SpanKind.CLIENT, attributes: spanAttrs }, parentCtx)
    : tracer.startSpan(spanName, { kind: SpanKind.CLIENT, attributes: spanAttrs });

  if (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error });
    span.recordException(new Error(error));
  }

  // DB query spans are instantaneous — end immediately with recorded duration
  span.end();
}

// ---------------------------------------------------------------------------
// db.query.completed — metrics handler (duration histogram)
// ---------------------------------------------------------------------------

export async function handleDbQueryMetrics(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const operation = String(p.operation ?? "unknown");
  const table = String(p.table ?? "unknown");
  const durationMs = Number(p.durationMs ?? 0);
  const description = p.description ? String(p.description) : undefined;
  const error = p.error ? String(p.error) : undefined;

  const durationHist = ctx.meter.createHistogram(
    METRIC_NAMES.dbQueryDuration,
    {
      description: "Duration of database queries in milliseconds",
      unit: "ms",
    },
  );
  durationHist.record(durationMs, {
    db_operation: operation,
    db_table: table,
    ...(description ? { db_query: description } : {}),
    status: error ? "error" : "ok",
  });

  if (error) {
    const errorCounter = ctx.meter.createCounter(METRIC_NAMES.dbQueryErrors, {
      description: "Count of failed database queries",
    });
    errorCounter.add(1, {
      db_operation: operation,
      db_table: table,
    });
  }
}
