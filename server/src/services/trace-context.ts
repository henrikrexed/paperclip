/**
 * Lightweight server-side trace context utilities.
 *
 * Uses @opentelemetry/api to:
 * - Create root/child spans for key server operations
 * - Extract the active span context for propagation to plugin events
 *
 * The server does NOT run a full OTel SDK — it only uses the API so that
 * when an external auto-instrumentation agent (e.g. OTEL_NODE_OPTIONS) is
 * present the spans participate in that pipeline. Without an agent, the
 * API is a no-op by design.
 */

import { trace, context, SpanKind, type Span, type Tracer } from "@opentelemetry/api";

const TRACER_NAME = "paperclip-server";
const TRACER_VERSION = "0.1.0";

let _tracer: Tracer | null = null;

function getTracer(): Tracer {
  if (!_tracer) {
    _tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);
  }
  return _tracer;
}

/**
 * Extract the active span's W3C trace context for embedding in plugin events.
 * Returns undefined when no span is active or the context is invalid.
 */
export function extractTraceContext(): { traceId: string; spanId: string; traceFlags: number } | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;

  const sc = span.spanContext();
  // A valid traceId is 32 hex chars, not all zeros
  if (!sc.traceId || sc.traceId === "00000000000000000000000000000000") return undefined;

  return {
    traceId: sc.traceId,
    spanId: sc.spanId,
    traceFlags: sc.traceFlags,
  };
}

/**
 * Start a root span for a heartbeat run and execute `fn` within its context.
 * The span is automatically ended when `fn` completes (success or error).
 */
export function withHeartbeatSpan<T>(
  runId: string,
  agentId: string,
  attrs: Record<string, string>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(
    "paperclip.heartbeat.dispatch",
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "paperclip.run.id": runId,
        "paperclip.agent.id": agentId,
        ...attrs,
      },
    },
    async (span) => {
      try {
        const result = await fn(span);
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: 2 /* ERROR */, message: String(err) });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Start a span for an issue lifecycle operation (create/update/comment)
 * and execute `fn` within its context.
 */
export function withIssueSpan<T>(
  operation: string,
  issueId: string,
  attrs: Record<string, string>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(
    `paperclip.issue.${operation}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "paperclip.issue.id": issueId,
        ...attrs,
      },
    },
    async (span) => {
      try {
        const result = await fn(span);
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: 2 /* ERROR */, message: String(err) });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Run `fn` within the context of the given span, so child spans and
 * extractTraceContext() see it as the active span.
 */
export function withSpanContext<T>(span: Span, fn: () => T): T {
  const ctx = trace.setSpan(context.active(), span);
  return context.with(ctx, fn);
}
