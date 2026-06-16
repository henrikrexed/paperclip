/**
 * Parent span family E2E — docker-free (ISI-1304 acceptance).
 *
 * Drives the *real* trace handlers (handleRunStartedTraces, handleCostTraces,
 * handleIssueCommentCreatedTraces, handleRunFinishedTraces) through a *real*
 * OTel NodeSDK. A custom span exporter does two things at once:
 *
 *   1. Captures the finished spans so we can assert the parent/child trace tree
 *      (traceId + parentSpanId linkage), and
 *   2. Forwards them to an OTLPTraceExporter that ships OTLP/proto to an
 *      in-process receiver — proving the family actually egresses on the wire.
 *
 * This validates the ISI-1304 keystone end-to-end without docker or a running
 * server: the server-propagated `traceContext` parents `paperclip.heartbeat.run`,
 * and the cost / comment / run.finished events all land under the same trace.
 *
 * Uses only dependencies already declared by this plugin (sdk-node,
 * exporter-trace-otlp-proto, resources, api) — no new packages.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { TelemetryContext } from "../src/telemetry/router.js";
import {
  handleRunStartedTraces,
  handleCostTraces,
  handleIssueCommentCreatedTraces,
  handleRunFinishedTraces,
} from "../src/telemetry/trace-handlers.js";

// Server-propagated W3C trace context (the ISI-1304 keystone hands this to the
// plugin via PluginEvent.traceContext).
const SERVER_TRACE_ID = "11112222333344445555666677778888";
const SERVER_SPAN_ID = "1122334455667788";

const RUN_ID = "run-fam-1";
const AGENT_ID = "agent-fam-1";
const AGENT_NAME = "Testing Architect";
const ISSUE_ID = "issue-fam-1";
const MODEL = "claude-opus-4";

// Minimal structural view of an OTel ReadableSpan (avoids a direct
// sdk-trace-base import, which this plugin does not declare).
interface SpanLike {
  name: string;
  spanContext(): { traceId: string; spanId: string };
  parentSpanContext?: { spanId: string };
  parentSpanId?: string;
  attributes: Record<string, unknown>;
  events: Array<{ name: string }>;
  status: { code: number };
}

interface CapturedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: Record<string, unknown>;
  eventNames: string[];
  statusCode: number;
}

function makeEvent(
  eventType: string,
  payload: Record<string, unknown>,
  withServerTrace = false,
): PluginEvent {
  return {
    eventId: `evt-${eventType}-${Date.now()}`,
    eventType: eventType as PluginEvent["eventType"],
    occurredAt: new Date().toISOString(),
    companyId: "company-fam",
    payload,
    ...(withServerTrace
      ? {
          traceContext: {
            traceId: SERVER_TRACE_ID,
            spanId: SERVER_SPAN_ID,
            traceFlags: 1,
          },
        }
      : {}),
  } as PluginEvent;
}

describe("OTLP-egress parent span family (ISI-1304)", () => {
  let server: http.Server;
  let port: number;
  let traceBodies: string[];
  let captured: CapturedSpan[];
  let sdk: NodeSDK;

  beforeEach(async () => {
    traceBodies = [];
    captured = [];
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (req.url === "/v1/traces") {
          traceBodies.push(Buffer.concat(chunks).toString("latin1"));
        }
        res.writeHead(200, { "content-type": "application/x-protobuf" });
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;

    // Custom exporter: capture span structure, then forward to OTLP/proto wire.
    const otlp = new OTLPTraceExporter({
      url: `http://127.0.0.1:${port}/v1/traces`,
    });
    const capturingExporter = {
      export(spans: SpanLike[], resultCallback: (r: { code: number }) => void) {
        for (const s of spans) {
          const sc = s.spanContext();
          captured.push({
            name: s.name,
            traceId: sc.traceId,
            spanId: sc.spanId,
            parentSpanId: s.parentSpanContext?.spanId ?? s.parentSpanId,
            attributes: s.attributes,
            eventNames: s.events.map((e) => e.name),
            statusCode: s.status.code,
          });
        }
        (otlp.export as unknown as (s: unknown, cb: (r: { code: number }) => void) => void)(
          spans,
          resultCallback,
        );
      },
      shutdown() {
        return otlp.shutdown();
      },
      forceFlush() {
        return Promise.resolve();
      },
    };

    sdk = new NodeSDK({
      resource: resourceFromAttributes({ "service.name": "paperclip-family-e2e" }),
      traceExporter: capturingExporter as unknown as ConstructorParameters<
        typeof NodeSDK
      >[0]["traceExporter"],
    });
    sdk.start();
  });

  afterEach(async () => {
    await sdk.shutdown().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function buildCtx(): TelemetryContext {
    const store = new Map<string, unknown>();
    const keyFor = (i: { scopeKind: string; scopeId?: string; stateKey: string }) =>
      `${i.scopeKind}:${i.scopeId ?? ""}:${i.stateKey}`;
    const tracer = trace.getTracer("paperclip-family-e2e");

    return {
      meter: {} as TelemetryContext["meter"],
      tracer,
      getTracerForAgent: () => tracer,
      state: {
        get: vi.fn(async (i) => store.get(keyFor(i)) ?? null),
        set: vi.fn(async (i, v) => {
          store.set(keyFor(i), v);
        }),
        delete: vi.fn(async (i) => {
          store.delete(keyFor(i));
        }),
      } as unknown as TelemetryContext["state"],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as unknown as TelemetryContext["logger"],
      // Fallback API lookups must return empty so resolvedIssueId stays empty and
      // the run span parents directly under the server-propagated trace context.
      issues: { list: vi.fn(async () => []) } as unknown as TelemetryContext["issues"],
      agents: { get: vi.fn(async () => null) } as unknown as TelemetryContext["agents"],
      companies: {
        list: vi.fn(async () => []),
      } as unknown as TelemetryContext["companies"],
      otelLogger: null,
      activeRunSpans: new Map(),
      activeIssueSpans: new Map(),
      activeApprovalSpans: new Map(),
      activeSessionSpans: new Map(),
      projectNameMap: new Map(),
      agentIssueMap: new Map(),
      issueContextMap: new Map(),
      agentActiveRunId: new Map(),
      agentNameMap: new Map(),
      endedRunSpanContexts: new Map(),
    } as TelemetryContext;
  }

  it("parents heartbeat.run under server trace and links cost/comment/finished children", async () => {
    const ctx = buildCtx();

    // 1. agent.run.started → paperclip.heartbeat.run parented under server trace.
    await handleRunStartedTraces(
      makeEvent(
        "agent.run.started",
        { runId: RUN_ID, agentId: AGENT_ID, agentName: AGENT_NAME, companyId: "company-fam" },
        true,
      ),
      ctx,
    );

    // 2. cost_event.created → LLM child span under the run span.
    await handleCostTraces(
      makeEvent("cost_event.created", {
        agentId: AGENT_ID,
        agentName: AGENT_NAME,
        provider: "anthropic",
        model: MODEL,
        heartbeatRunId: RUN_ID,
        inputTokens: 100,
        outputTokens: 50,
        costCents: 12,
      }),
      ctx,
    );

    // 3. issue.comment.created → span event on the open run span.
    await handleIssueCommentCreatedTraces(
      makeEvent("issue.comment.created", {
        issueId: ISSUE_ID,
        id: "comment-1",
        authorAgentId: AGENT_ID,
      }),
      ctx,
    );

    // 4. agent.run.finished → ends run span OK with exit_code.
    await handleRunFinishedTraces(
      makeEvent("agent.run.finished", {
        runId: RUN_ID,
        agentId: AGENT_ID,
        exitCode: 0,
        durationMs: 4200,
      }),
      ctx,
    );

    // shutdown() force-flushes the batch processor to both exporters.
    await sdk.shutdown();

    // --- Parent span family structure ---
    const runSpan = captured.find((s) => s.name === "paperclip.heartbeat.run");
    expect(runSpan, "paperclip.heartbeat.run must be exported").toBeDefined();
    expect(runSpan!.traceId).toBe(SERVER_TRACE_ID);
    // Parented under the server-propagated span → true distributed trace linkage.
    expect(runSpan!.parentSpanId).toBe(SERVER_SPAN_ID);

    const costSpan = captured.find((s) => s.name === `chat ${MODEL}`);
    expect(costSpan, "cost LLM span must be exported").toBeDefined();
    // Same trace, child of the run span.
    expect(costSpan!.traceId).toBe(SERVER_TRACE_ID);
    expect(costSpan!.parentSpanId).toBe(runSpan!.spanId);

    // --- ISI-1308 M3 acceptance: chat turn span carries model + token attrs ---
    // The run shows a chat-turn span with model + token attributes under the run
    // span. These come from cost_event.created (token/model), not agent.session.*.
    expect(costSpan!.attributes["gen_ai.operation.name"]).toBe("chat");
    expect(costSpan!.attributes["gen_ai.request.model"]).toBe(MODEL);
    expect(costSpan!.attributes["gen_ai.usage.input_tokens"]).toBe(100);
    expect(costSpan!.attributes["gen_ai.usage.output_tokens"]).toBe(50);
    expect(costSpan!.attributes["gen_ai.usage.total_tokens"]).toBe(150);

    // issue.comment.created lands as a span event on the run span.
    expect(runSpan!.eventNames).toContain("issue.comment.created");

    // agent.run.finished closed the run span OK with exit code.
    expect(runSpan!.statusCode).toBe(SpanStatusCode.OK);
    expect(runSpan!.attributes["paperclip.run.exit_code"]).toBe(0);

    // Every exported span shares the one server-rooted trace.
    for (const s of captured) {
      expect(s.traceId).toBe(SERVER_TRACE_ID);
    }

    // --- OTLP/proto egress: the family actually shipped on the wire ---
    const wire = traceBodies.join("");
    expect(traceBodies.length, "at least one /v1/traces export").toBeGreaterThan(0);
    expect(wire).toContain("paperclip.heartbeat.run");
    // OTLP/proto serializes trace_id as raw 16 bytes — assert the server trace id
    // bytes are present in the exported payload.
    const traceIdBytes = Buffer.from(SERVER_TRACE_ID, "hex").toString("latin1");
    expect(wire).toContain(traceIdBytes);
  });
});
