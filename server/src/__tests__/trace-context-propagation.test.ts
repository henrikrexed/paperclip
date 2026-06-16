import { describe, it, expect } from "vitest";
import {
  withHeartbeatSpan,
  withIssueSpan,
  extractTraceContext,
} from "../services/trace-context.js";

describe("server trace-context keystone (ISI-1304)", () => {
  it("returns no trace context when no span is active", () => {
    expect(extractTraceContext()).toBeUndefined();
  });

  it("withHeartbeatSpan establishes an active span whose context is extractable", async () => {
    let inside: ReturnType<typeof extractTraceContext>;
    await withHeartbeatSpan("run-1", "agent-1", { "paperclip.company.id": "co-1" }, async () => {
      inside = extractTraceContext();
    });

    expect(inside).toBeDefined();
    expect(inside?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(inside?.traceId).not.toBe("00000000000000000000000000000000");
    expect(inside?.spanId).toMatch(/^[0-9a-f]{16}$/);

    // Span context must not leak after the heartbeat span ends.
    expect(extractTraceContext()).toBeUndefined();
  });

  it("withIssueSpan nests under the heartbeat span sharing one trace", async () => {
    let heartbeatCtx: ReturnType<typeof extractTraceContext>;
    let issueCtx: ReturnType<typeof extractTraceContext>;

    await withHeartbeatSpan("run-2", "agent-2", {}, async () => {
      heartbeatCtx = extractTraceContext();
      await withIssueSpan("execution", "issue-2", { "paperclip.agent.id": "agent-2" }, async () => {
        issueCtx = extractTraceContext();
      });
    });

    expect(heartbeatCtx).toBeDefined();
    expect(issueCtx).toBeDefined();
    // Same trace, distinct spans → child-parent linkage within one trace tree.
    expect(issueCtx?.traceId).toBe(heartbeatCtx?.traceId);
    expect(issueCtx?.spanId).not.toBe(heartbeatCtx?.spanId);
  });
});
