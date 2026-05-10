import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentRuntimeState,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { agentRoutes } from "../routes/agents.ts";
import { errorHandler } from "../middleware/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres lastErrorMessage tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent.lastErrorMessage persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-last-error-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Alfred",
      role: "general",
      title: "CTO",
      status: "running",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function getAgentRow(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  it("persists the LAST failure error message after three sequential agent.run.failed events", async () => {
    const { agentId } = await seedAgent();
    const heartbeat = heartbeatService(db);

    const failures = [
      "FallbackSummaryError: gateway transient timeout (run 1)",
      "FallbackSummaryError: gateway transient timeout (run 2)",
      "FallbackSummaryError: gateway transient timeout (run 3)",
    ];
    for (const message of failures) {
      await heartbeat.finalizeAgentStatus(agentId, "failed", message);
    }

    const row = await getAgentRow(agentId);
    expect(row?.status).toBe("error");
    expect(row?.lastErrorMessage).toBe(failures[failures.length - 1]);
  });

  it("clears lastErrorMessage when the agent recovers via a successful run", async () => {
    const { agentId } = await seedAgent();
    const heartbeat = heartbeatService(db);

    await heartbeat.finalizeAgentStatus(agentId, "failed", "FallbackSummaryError: boom 1");
    await heartbeat.finalizeAgentStatus(agentId, "failed", "FallbackSummaryError: boom 2");
    await heartbeat.finalizeAgentStatus(agentId, "failed", "FallbackSummaryError: boom 3");

    let row = await getAgentRow(agentId);
    expect(row?.status).toBe("error");
    expect(row?.lastErrorMessage).toContain("boom 3");

    await heartbeat.finalizeAgentStatus(agentId, "succeeded", null);

    row = await getAgentRow(agentId);
    expect(row?.status).toBe("idle");
    expect(row?.lastErrorMessage).toBeNull();
  });

  it("stores nothing for empty/whitespace error strings on error transitions", async () => {
    const { agentId } = await seedAgent();
    const heartbeat = heartbeatService(db);

    await heartbeat.finalizeAgentStatus(agentId, "failed", "   ");
    const row = await getAgentRow(agentId);
    expect(row?.status).toBe("error");
    expect(row?.lastErrorMessage).toBeNull();
  });

  it("exposes lastErrorMessage on GET /api/agents/:id", async () => {
    const { companyId, agentId } = await seedAgent();
    const heartbeat = heartbeatService(db);
    await heartbeat.finalizeAgentStatus(agentId, "failed", "FallbackSummaryError: surfaced via API");

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "local-board",
        companyIds: [companyId],
        source: "local_implicit",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);

    const response = await request(app).get(`/api/agents/${agentId}`);
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(agentId);
    expect(response.body.status).toBe("error");
    expect(response.body.lastErrorMessage).toBe("FallbackSummaryError: surfaced via API");
  });
});
