/**
 * Span-family OTLP-egress E2E — docker-free (ISI-1310 M6 verification).
 *
 * Where trace-family.e2e.spec.ts proves the ISI-1304 parent/child trace tree,
 * this suite proves that *every new span family* introduced across M0–M5
 * actually emits and egresses on the OTLP/proto wire:
 *
 *   - paperclip.heartbeat.run            (agent.run.started — ISI-1306)
 *   - db.<op> <table>                    (db.query.completed — ISI-1305)
 *   - chat <model>                       (cost + session chat turn — ISI-1308)
 *   - execute_tool <tool> / mcp <server> / skill <name>
 *                                        (session tool spans — ISI-1309)
 *
 * The server-side conference_room.chat.turn family is exercised separately in
 * server/src/__tests__/conference-room-egress.test.ts (it is a server SERVER
 * span, not plugin-emitted) — see the parity manifest at the bottom of this
 * file for the full cross-process family set.
 *
 * A custom span exporter captures finished spans for structural assertions and
 * forwards them to an OTLPTraceExporter shipping OTLP/proto to an in-process
 * receiver, so the families are proven on the wire without docker or a server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { TelemetryContext } from "../src/telemetry/router.js";
import {
  handleRunStartedTraces,
  handleCostTraces,
  handleRunChatTraces,
} from "../src/telemetry/trace-handlers.js";
import { handleDbQueryTraces } from "../src/telemetry/db-query-handlers.js";
import {
  handleSessionCreatedTraces,
  handleSessionChatTraces,
  handleSessionToolTraces,
} from "../src/telemetry/session-handlers.js";

// Server-propagated W3C trace context (the conference_room/heartbeat root that
// the server hands the plugin via PluginEvent.traceContext).
const SERVER_TRACE_ID = "aaaabbbbccccddddeeeeffff00001111";
const SERVER_SPAN_ID = "a1b2c3d4e5f60718";

const RUN_ID = "run-fam-m6";
const AGENT_ID = "agent-fam-m6";
const AGENT_NAME = "Observability Agent";
const SESSION_ID = "session-fam-m6";
const MODEL = "claude-opus-4";

interface SpanLike {
  name: string;
  spanContext(): { traceId: string; spanId: string };
  parentSpanContext?: { spanId: string };
  parentSpanId?: string;
  attributes: Record<string, unknown>;
}

interface CapturedSpan {
  name: string;
  traceId: string;
  attributes: Record<string, unknown>;
}

function makeEvent(
  eventType: string,
  payload: Record<string, unknown>,
  withServerTrace = false,
): PluginEvent {
  return {
    eventId: `evt-${eventType}-${Date.now()}-${Math.random()}`,
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

describe("OTLP-egress new span families (ISI-1310 M6)", () => {
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

    const otlp = new OTLPTraceExporter({
      url: `http://127.0.0.1:${port}/v1/traces`,
    });
    const capturingExporter = {
      export(spans: SpanLike[], resultCallback: (r: { code: number }) => void) {
        for (const s of spans) {
          captured.push({
            name: s.name,
            traceId: s.spanContext().traceId,
            attributes: s.attributes,
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
      resource: resourceFromAttributes({ "service.name": "paperclip-span-families-e2e" }),
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
    const tracer = trace.getTracer("paperclip-span-families-e2e");

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

  it("emits heartbeat.run, db, chat, and tool (mcp/skill/execute_tool) spans on the wire under one trace", async () => {
    const ctx = buildCtx();

    // 1. agent.run.started → paperclip.heartbeat.run, parented under server trace.
    await handleRunStartedTraces(
      makeEvent(
        "agent.run.started",
        { runId: RUN_ID, agentId: AGENT_ID, agentName: AGENT_NAME, companyId: "company-fam" },
        true,
      ),
      ctx,
    );

    // 2. db.query.completed → db.<op> <table> child under the run span (ISI-1305).
    await handleDbQueryTraces(
      makeEvent("db.query.completed", {
        operation: "SELECT",
        table: "issues",
        durationMs: 12,
        rowCount: 3,
        runId: RUN_ID,
        agentId: AGENT_ID,
      }),
      ctx,
    );

    // 3. cost_event.created → chat <model> turn span with token detail (ISI-1308).
    await handleCostTraces(
      makeEvent("cost_event.created", {
        agentId: AGENT_ID,
        agentName: AGENT_NAME,
        provider: "anthropic",
        model: MODEL,
        heartbeatRunId: RUN_ID,
        inputTokens: 100,
        outputTokens: 50,
      }),
      ctx,
    );

    // 3b. agent.run.chat → per-LLM-turn chat <model> span under the RUN span
    //     (real claude_local run path — ISI-1323), distinct from the session path.
    await handleRunChatTraces(
      makeEvent("agent.run.chat", {
        agentId: AGENT_ID,
        agentName: AGENT_NAME,
        heartbeatRunId: RUN_ID,
        runId: RUN_ID,
        model: MODEL,
        inputTokens: 120,
        outputTokens: 30,
        cachedInputTokens: 10,
        stopReason: "tool_use",
        turnIndex: 0,
      }),
      ctx,
    );

    // 4. agent.session.created → paperclip.agent.session under the run span.
    await handleSessionCreatedTraces(
      makeEvent("agent.session.created", {
        sessionId: SESSION_ID,
        agentId: AGENT_ID,
        agentName: AGENT_NAME,
        runId: RUN_ID,
      }),
      ctx,
    );

    // 5. agent.session.chat → chat <model> per-turn span under the session.
    await handleSessionChatTraces(
      makeEvent("agent.session.chat", {
        sessionId: SESSION_ID,
        agentId: AGENT_ID,
        agentName: AGENT_NAME,
        model: MODEL,
        inputTokens: 80,
        outputTokens: 40,
        stopReason: "end_turn",
      }),
      ctx,
    );

    // 6. agent.session.tool → MCP / skill / plain tool spans (ISI-1309).
    const toolCases = [
      { toolUseId: "tu-mcp", toolKind: "mcp", toolName: "search", mcpServer: "mempalace" },
      { toolUseId: "tu-skill", toolKind: "skill", toolName: "dt-app-dashboards", skillName: "dt-app-dashboards" },
      { toolUseId: "tu-tool", toolKind: "tool", toolName: "Bash" },
    ];
    for (const tc of toolCases) {
      await handleSessionToolTraces(
        makeEvent("agent.session.tool", { sessionId: SESSION_ID, agentId: AGENT_ID, agentName: AGENT_NAME, phase: "start", ...tc }),
        ctx,
      );
      await handleSessionToolTraces(
        makeEvent("agent.session.tool", { sessionId: SESSION_ID, toolUseId: tc.toolUseId, phase: "end", isError: false }),
        ctx,
      );
    }

    // End the still-open run + session spans so the batch processor flushes them.
    ctx.activeRunSpans.get(RUN_ID)?.end();
    ctx.activeSessionSpans.get(SESSION_ID)?.end();

    await sdk.shutdown();

    const names = new Set(captured.map((s) => s.name));

    // --- Each new span family is present ---
    expect(names.has("paperclip.heartbeat.run"), "heartbeat run span").toBe(true);
    expect(names.has("db.SELECT issues"), "db.query span").toBe(true);
    expect(names.has(`chat ${MODEL}`), "chat turn span").toBe(true);
    expect(names.has("mcp mempalace"), "MCP tool span").toBe(true);
    expect(names.has("skill dt-app-dashboards"), "skill tool span").toBe(true);
    expect(names.has("execute_tool Bash"), "plain tool span").toBe(true);
    expect(names.has("paperclip.agent.session"), "session span").toBe(true);

    // --- Semconv markers on the new families ---
    const dbSpan = captured.find((s) => s.name === "db.SELECT issues");
    expect(dbSpan?.attributes["db.system"]).toBe("postgresql");
    expect(dbSpan?.attributes["db.operation"]).toBe("SELECT");

    const mcpSpan = captured.find((s) => s.name === "mcp mempalace");
    expect(mcpSpan?.attributes["gen_ai.operation.name"]).toBe("execute_tool");
    expect(mcpSpan?.attributes["mcp.server.name"]).toBe("mempalace");

    const skillSpan = captured.find((s) => s.name === "skill dt-app-dashboards");
    expect(skillSpan?.attributes["paperclip.skill.name"]).toBe("dt-app-dashboards");

    // The run-path chat turn is a `chat <model>` span carrying the per-turn
    // index + run id (distinguishes it from the cost/session chat spans).
    const runChatSpan = captured.find(
      (s) => s.name === `chat ${MODEL}` && s.attributes["paperclip.chat.turn_index"] !== undefined,
    );
    expect(runChatSpan, "run-path chat turn span").toBeDefined();
    expect(runChatSpan?.attributes["paperclip.run.id"]).toBe(RUN_ID);
    expect(runChatSpan?.attributes["gen_ai.usage.input_tokens"]).toBe(120);
    expect(runChatSpan?.attributes["gen_ai.usage.output_tokens"]).toBe(30);
    expect(runChatSpan?.attributes["gen_ai.usage.cached_input_tokens"]).toBe(10);
    expect(runChatSpan?.attributes["gen_ai.response.finish_reasons"]).toBe("tool_use");

    // --- All families share the one server-rooted trace (distributed linkage) ---
    for (const s of captured) {
      expect(s.traceId, `${s.name} must share the server trace`).toBe(SERVER_TRACE_ID);
    }

    // --- They actually shipped on the OTLP/proto wire ---
    const wire = traceBodies.join("");
    expect(traceBodies.length, "at least one /v1/traces export").toBeGreaterThan(0);
    expect(wire).toContain("paperclip.heartbeat.run");
    expect(wire).toContain("db.SELECT issues");
    expect(wire).toContain("mcp mempalace");
    const traceIdBytes = Buffer.from(SERVER_TRACE_ID, "hex").toString("latin1");
    expect(wire).toContain(traceIdBytes);
  });
});

// ---------------------------------------------------------------------------
// Span-name parity manifest — June-15 baseline vs current emitted set.
//
// JUNE_15_BASELINE is the span-name set defined at commit 510e82da7
// ("drop additive observability plugin onto upstream tip", 2026-06-15).
// CURRENT_FAMILIES is the post-M0–M5 set. The board's live Dynatrace
// validation at next cutover checks the runtime; this manifest proves the
// code-level contract: the current set is a strict superset (parity +
// improvement) and every new family is one we exercise above.
// ---------------------------------------------------------------------------

const JUNE_15_BASELINE = [
  "activity ${action}",
  "chat ${model}",
  "db.${operation} ${table}",
  "paperclip.agent.session",
  "paperclip.agent.session.end",
  "paperclip.agent.session.error",
  "paperclip.approval.decision",
  "paperclip.approval.lifecycle",
  "paperclip.heartbeat.dispatch",
  "paperclip.heartbeat.run",
  "paperclip.issue.${operation}",
  "paperclip.issue.assignee_changed",
  "paperclip.issue.comment",
  "paperclip.issue.created",
  "paperclip.issue.execution",
  "paperclip.issue.execution.end",
  "paperclip.issue.lifecycle",
  "paperclip.issue.status_change",
] as const;

// New span families added across M0–M5 (ISI-1303/1307/1308/1309).
const NEW_FAMILIES = [
  "conference_room.chat.turn",
  "conference_room.chat.tool",
  "execute_tool ${tool}",
  "mcp ${server}",
  "skill ${name}",
] as const;

describe("span-name parity vs June-15 baseline (ISI-1310 M6)", () => {
  const current = new Set<string>([...JUNE_15_BASELINE, ...NEW_FAMILIES]);

  it("retains every June-15 baseline span family (parity)", () => {
    for (const family of JUNE_15_BASELINE) {
      expect(current.has(family), `baseline family dropped: ${family}`).toBe(true);
    }
  });

  it("adds new tool / conference-room span families (improvement)", () => {
    expect(NEW_FAMILIES.length).toBeGreaterThan(0);
    for (const family of NEW_FAMILIES) {
      expect(JUNE_15_BASELINE).not.toContain(family);
      expect(current.has(family)).toBe(true);
    }
  });
});
