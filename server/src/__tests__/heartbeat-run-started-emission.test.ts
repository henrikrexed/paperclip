import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Capture the run-lifecycle plugin events in emission order. ISI-1306 M2:
// `claimQueuedRun` must route its "running" transition through the emitter so
// `agent.run.started` opens the run span at run start (not just on finish).
const publishedEvents = vi.hoisted(
  () =>
    [] as Array<{
      eventType: string;
      runId: string;
      traceContext?: { traceId: string; spanId: string; traceFlags: number };
    }>,
);

vi.mock("../services/activity-log.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../services/activity-log.ts")>(
      "../services/activity-log.ts",
    );
  return {
    ...actual,
    publishPluginDomainEvent: vi.fn(
      (event: {
        eventType: string;
        payload?: Record<string, unknown>;
        traceContext?: { traceId: string; spanId: string; traceFlags: number };
      }) => {
        publishedEvents.push({
          eventType: event.eventType,
          runId: String(event.payload?.runId ?? ""),
          traceContext: event.traceContext,
        });
      },
    ),
  };
});

// The adapter blocks until the test releases it. This keeps the claimed run in
// the "running" state so we can prove agent.run.started fired at claim time —
// before any finish/continuation work — without racing teardown.
let releaseAdapter: () => void = () => {};
const adapterGate = vi.hoisted(() => ({ promise: Promise.resolve() }));

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "agent.run.started emission test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent.run.started emission test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(fn: () => Promise<boolean> | boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return fn();
}

async function truncateAll(db: ReturnType<typeof createDb>) {
  // Background heartbeat queries can briefly hold locks after a run leaves the
  // running state; retry the exclusive TRUNCATE through transient deadlocks.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await db.execute(sql.raw(`
        TRUNCATE TABLE
          "issue_comments",
          "issues",
          "heartbeat_run_events",
          "activity_log",
          "heartbeat_runs",
          "agent_wakeup_requests",
          "agent_runtime_state",
          "agents",
          "companies"
        RESTART IDENTITY CASCADE
      `));
      return;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      const transient = code === "40P01" || code === "23503"; // deadlock / FK race
      if (!transient || attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describeEmbeddedPostgres("heartbeat agent.run.started emission (ISI-1306 M2)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-run-started-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    // Release the blocked adapter so the parked executeRun promise can unwind,
    // then wait for the run to leave the running/queued state before cleanup.
    releaseAdapter();
    await waitForCondition(async () => {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      return !runs.some((r) => r.status === "queued" || r.status === "running");
    }, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await truncateAll(db);
    publishedEvents.length = 0;
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
  });

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await tempDb?.cleanup();
  }, 30_000);

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Actionable task",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    return { companyId, agentId, issueId, runId };
  }

  it("fires agent.run.started at claim while the run is still running (not on finish)", async () => {
    // Block the adapter so the run stays "running" after it is claimed.
    adapterGate.promise = new Promise<void>((resolve) => {
      releaseAdapter = resolve;
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await adapterGate.promise;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "agent.run.started emission test run.",
        provider: "test",
        model: "test-model",
      };
    });

    const { runId } = await seedFixture();

    await heartbeat.resumeQueuedRuns();

    // agent.run.started must be published for this run while the adapter is
    // still blocked — i.e. emitted at claim time, before any finish event.
    const started = await waitForCondition(
      () =>
        publishedEvents.some(
          (e) => e.runId === runId && e.eventType === "agent.run.started",
        ),
      5_000,
    );
    expect(started).toBe(true);

    // The run is mid-flight (adapter blocked), so no terminal event can have
    // fired yet — proving the span opens at start, not just on finish.
    const finishedBeforeRelease = publishedEvents.some(
      (e) =>
        e.runId === runId &&
        ["agent.run.finished", "agent.run.failed", "agent.run.cancelled"].includes(
          e.eventType,
        ),
    );
    expect(finishedBeforeRelease).toBe(false);

    const run = await db
      .select({ status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("running");
    expect(run?.startedAt).not.toBeNull();

    // ISI-1324: agent.run.started must carry the server span's trace context so
    // the plugin's paperclip.heartbeat.run span parents under the heartbeat/issue
    // span rather than floating near-root. The event is raised inside
    // executeRun's withHeartbeatSpan/withIssueSpan, so a valid (non-zero) traceId
    // must be present.
    const startedEvent = publishedEvents.find(
      (e) => e.runId === runId && e.eventType === "agent.run.started",
    );
    expect(startedEvent?.traceContext).toBeDefined();
    expect(startedEvent?.traceContext?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(startedEvent?.traceContext?.traceId).not.toBe(
      "00000000000000000000000000000000",
    );
    expect(startedEvent?.traceContext?.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});
