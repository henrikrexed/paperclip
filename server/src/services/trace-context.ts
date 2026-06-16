/**
 * Server-side trace context — creates real spans and propagates context to plugins.
 *
 * Registers a BasicTracerProvider so that spans have valid trace/span IDs.
 *
 * Export behaviour depends on `OTEL_EXPORTER_OTLP_ENDPOINT`:
 *   - Set   → the server's own spans (heartbeat dispatch, issue, db) are
 *             exported to the collector via an OTLP/HTTP BatchSpanProcessor,
 *             so the server run span anchors the trace in the backend.
 *   - Unset → a NoopExporter is used. Spans are ephemeral; their only purpose
 *             is to generate trace context that the observability plugin
 *             receives via PluginEvent.traceContext and re-exports.
 *
 * The auto-instrumentation NodeSDK in instrumentation.ts is the richer
 * alternative (HTTP/Express/PG spans), but it requires the optional
 * @opentelemetry/sdk-node + auto-instrumentations-node packages. When those
 * are absent it fails gracefully and registers no provider; this module then
 * becomes the export path. When a NodeSDK provider *is* present, the
 * `hasProvider` probe below defers to it — so there is never a double provider.
 */

import { trace, context, SpanKind, type Context, type Span, type Tracer } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

const TRACER_NAME = "paperclip-server";
const TRACER_VERSION = "0.1.0";

let _initialized = false;
let _tracer: Tracer | null = null;
let _provider: BasicTracerProvider | null = null;

/**
 * A no-op exporter that discards all spans.
 * We only need the TracerProvider to generate valid trace/span IDs.
 */
class NoopExporter implements SpanExporter {
  export(spans: ReadableSpan[], resultCallback: (result: { code: number }) => void): void {
    resultCallback({ code: 0 /* SUCCESS */ });
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Build the span processor for the server's own provider. When an OTLP
 * endpoint is configured the spans are exported to the collector; otherwise
 * they are discarded (the trace context is still generated for the plugin).
 *
 * The exporter is constructed without an explicit `url` so it reads
 * OTEL_EXPORTER_OTLP_ENDPOINT itself and appends the `/v1/traces` path per the
 * OTLP spec — matching instrumentation.ts's HTTP path exactly.
 */
export function buildSpanProcessor(): SpanProcessor {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (endpoint) {
    return new BatchSpanProcessor(new OTLPTraceExporter());
  }
  return new SimpleSpanProcessor(new NoopExporter());
}

/**
 * Initialize the server's TracerProvider. Safe to call multiple times —
 * only the first call has effect. If a TracerProvider is already registered
 * (e.g. by auto-instrumentation), this is a no-op.
 */
export function initServerTracing(): void {
  if (_initialized) return;
  _initialized = true;

  // Check if a TracerProvider is already registered (e.g. by auto-instrumentation).
  // The default no-op provider returns a ProxyTracer — we detect this by checking
  // if startSpan produces spans with all-zero traceIds.
  const testTracer = trace.getTracer("__probe__");
  const testSpan = testTracer.startSpan("__probe__");
  const hasProvider = testSpan.spanContext().traceId !== "00000000000000000000000000000000";
  testSpan.end();

  if (hasProvider) {
    // External provider already registered — use it.
    return;
  }

  const resource = resourceFromAttributes({
    "service.name": "paperclip-server",
    "service.version": TRACER_VERSION,
  });

  const provider = new BasicTracerProvider({
    resource,
    spanProcessors: [buildSpanProcessor()],
  });
  _provider = provider;

  // Register async context propagation so startActiveSpan/getActiveSpan work
  // across async boundaries (required for trace context to flow through await).
  const contextManager = new AsyncLocalStorageContextManager();
  context.setGlobalContextManager(contextManager);

  // Register as global so trace.getTracer() and trace.getActiveSpan() work.
  trace.setGlobalTracerProvider(provider);
}

/**
 * Flush and shut down the server's TracerProvider. When the BatchSpanProcessor
 * is active this drains the final buffered batch to the collector — without it,
 * spans queued at exit are dropped. No-op when this module never created a
 * provider (e.g. auto-instrumentation owns it, which index.ts shuts down via
 * shutdownInstrumentation()).
 */
export async function shutdownServerTracing(): Promise<void> {
  const provider = _provider;
  if (!provider) return;
  _provider = null;
  try {
    await provider.shutdown();
  } catch {
    // Best-effort flush; an unreachable collector must not block process exit.
  }
}

function getTracer(): Tracer {
  if (!_tracer) {
    initServerTracing();
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
 * Capture the currently-active OTel context and return a wrapper that re-enters
 * it when invoked. Needed for callbacks fired from outside the active context —
 * e.g. an adapter's stream-event sink, which the runner invokes from a child
 * process's stdout handler where AsyncLocalStorage has already unwound. Calling
 * this inside the run span and using the result for the callback guarantees
 * `extractTraceContext()` (called downstream by logActivity) still resolves the
 * run span, so per-turn events parent correctly under it.
 */
export function bindActiveContext<A extends unknown[]>(
  fn: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  const captured: Context = context.active();
  return (...args: A) => context.with(captured, () => fn(...args));
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
 * Start a root span for one conference-room (board-chat) turn and execute
 * `fn` within its context. The relay spawns the `claude` CLI and streams a
 * reply; this span is the parent of the resulting comment events and any
 * tool/turn child spans, giving the board a `conference_room.chat.turn`
 * span tree on OTLP egress.
 */
export function withConferenceRoomSpan<T>(
  attrs: Record<string, string | number>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(
    "conference_room.chat.turn",
    { kind: SpanKind.SERVER, attributes: attrs },
    async (span) => {
      try {
        return await fn(span);
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
 * Start a child span under an explicit parent. Needed where the active
 * context is not propagated to the call site (e.g. EventEmitter callbacks
 * such as a child process's stdout handler). The caller owns ending it.
 */
export function startChildSpan(
  parent: Span,
  name: string,
  attrs: Record<string, string | number>,
): Span {
  const tracer = getTracer();
  const parentCtx = trace.setSpan(context.active(), parent);
  return tracer.startSpan(name, { kind: SpanKind.INTERNAL, attributes: attrs }, parentCtx);
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

