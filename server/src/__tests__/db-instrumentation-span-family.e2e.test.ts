/**
 * DB query span family E2E — ISI-1305 acceptance (docker-free).
 *
 * Drives the *real* `instrumentQuery()` wrapper through a *real* OTel
 * BasicTracerProvider + AsyncLocalStorageContextManager (the same stack the
 * server registers in trace-context.ts). A parent span stands in for the M0
 * heartbeat run span; the query wrapper runs inside its active context.
 *
 * Asserts the two halves of the acceptance:
 *   1. `db.<op> <table>` spans are exported as children of the run span
 *      (same traceId, parentSpanId === run spanId) with table / duration /
 *      statement attributes.
 *   2. The fire-and-forget `db.query.completed` plugin event carries the same
 *      table / operation / duration so the plugin's histogram has real data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { context, trace, SpanKind } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import {
  instrumentQuery,
  setDbInstrumentationEventBus,
} from "../services/db-instrumentation.js";

const TRACER_NAME = "paperclip-server";

describe("db.query span family (ISI-1305)", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let contextManager: AsyncLocalStorageContextManager;
  let emitted: PluginEvent[];

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    contextManager = new AsyncLocalStorageContextManager();
    context.setGlobalContextManager(contextManager);
    trace.setGlobalTracerProvider(provider);

    emitted = [];
    setDbInstrumentationEventBus({
      emit: vi.fn(async (event: PluginEvent) => {
        emitted.push(event);
        return { errors: [] as Array<{ pluginId: string; error: unknown }> };
      }),
    } as unknown as Parameters<typeof setDbInstrumentationEventBus>[0]);
  });

  afterEach(async () => {
    await provider.shutdown();
    contextManager.disable();
    context.disable();
    trace.disable();
  });

  it("emits db.query spans as children of the run span with table/duration/statement", async () => {
    const tracer = trace.getTracer(TRACER_NAME);

    // M0 stand-in: the heartbeat run span that should parent the db query span.
    const runSpan = await tracer.startActiveSpan(
      "paperclip.heartbeat.run",
      { kind: SpanKind.INTERNAL },
      async (span) => {
        const rows = await instrumentQuery(
          {
            operation: "update",
            table: "issues",
            description: "issue checkout",
            agentId: "agent-1",
            runId: "run-1",
          },
          async () => {
            await new Promise((r) => setTimeout(r, 5));
            return [{ id: "issue-1" }, { id: "issue-2" }];
          },
        );
        expect(rows).toHaveLength(2);
        span.end();
        return span;
      },
    );

    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const dbSpan = spans.find((s) => s.name === "db.update issues");
    expect(dbSpan, "db.update issues span must be exported").toBeDefined();

    // Child of the run span: same trace, parented under the run span.
    const runCtx = runSpan.spanContext();
    expect(dbSpan!.spanContext().traceId).toBe(runCtx.traceId);
    expect(dbSpan!.parentSpanContext?.spanId).toBe(runCtx.spanId);

    // Table / duration / statement attributes (stable + new semconv).
    expect(dbSpan!.attributes["db.sql.table"]).toBe("issues");
    expect(dbSpan!.attributes["db.collection.name"]).toBe("issues");
    expect(dbSpan!.attributes["db.operation"]).toBe("update");
    expect(dbSpan!.attributes["db.query.summary"]).toBe("issue checkout");
    expect(
      dbSpan!.attributes["db.query.duration_ms"] as number,
    ).toBeGreaterThanOrEqual(0);
    expect(dbSpan!.attributes["db.response.rows"]).toBe(2);

    // The fire-and-forget plugin event mirrors the span.
    const event = emitted.find((e) => e.eventType === "db.query.completed");
    expect(event, "db.query.completed event must be emitted").toBeDefined();
    const payload = event!.payload as Record<string, unknown>;
    expect(payload.table).toBe("issues");
    expect(payload.operation).toBe("update");
    expect(payload.runId).toBe("run-1");
    expect(payload.rowCount).toBe(2);
    expect(payload.durationMs as number).toBeGreaterThanOrEqual(0);
    // Event carries the run-rooted trace context for plugin-side parenting.
    expect(event!.traceContext?.traceId).toBe(runCtx.traceId);
  });

  it("records exception status on the db span when the query throws", async () => {
    const tracer = trace.getTracer(TRACER_NAME);
    const boom = new Error("constraint violation");

    await tracer.startActiveSpan(
      "paperclip.heartbeat.run",
      { kind: SpanKind.INTERNAL },
      async (span) => {
        await expect(
          instrumentQuery(
            { operation: "insert", table: "issues", description: "issue create" },
            async () => {
              throw boom;
            },
          ),
        ).rejects.toThrow("constraint violation");
        span.end();
      },
    );

    await provider.forceFlush();

    const dbSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === "db.insert issues");
    expect(dbSpan, "errored db span must still be exported").toBeDefined();
    // SpanStatusCode.ERROR === 2
    expect(dbSpan!.status.code).toBe(2);

    const event = emitted.find((e) => e.eventType === "db.query.completed");
    expect((event!.payload as Record<string, unknown>).error).toBe(
      "Error: constraint violation",
    );
  });
});
