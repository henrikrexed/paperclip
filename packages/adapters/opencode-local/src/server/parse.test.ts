import { describe, expect, it } from "vitest";
import type { AdapterStreamEvent } from "@paperclipai/adapter-utils";
import {
  createOpenCodeStreamEventParser,
  parseOpenCodeJsonl,
  isOpenCodeUnknownSessionError,
} from "./parse.js";

describe("parseOpenCodeJsonl", () => {
  it("parses assistant text, usage, cost, and errors", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Hello from OpenCode" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_123",
        part: {
          reason: "done",
          cost: 0.0025,
          tokens: {
            input: 120,
            output: 40,
            reasoning: 10,
            cache: { read: 20, write: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: "model unavailable" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Hello from OpenCode");
    expect(parsed.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
    expect(parsed.costUsd).toBeCloseTo(0.0025, 6);
    expect(parsed.errorMessage).toContain("model unavailable");
    expect(parsed.toolErrors).toEqual([]);
  });

  it("keeps failed tool calls separate from fatal run errors", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_123",
        part: {
          state: {
            status: "error",
            error: "File not found: e2b-adapter-result.txt",
          },
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Recovered and completed the task" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Recovered and completed the task");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.toolErrors).toEqual(["File not found: e2b-adapter-result.txt"]);
  });

  it("detects unknown session errors", () => {
    expect(isOpenCodeUnknownSessionError("Session not found: s_123", "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOpenCodeUnknownSessionError("all good", "")).toBe(false);
  });
});

describe("createOpenCodeStreamEventParser", () => {
  function stepFinish(opts: {
    reason?: string;
    tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number } };
  }): string {
    return JSON.stringify({
      type: "step_finish",
      sessionID: "session_123",
      part: {
        reason: opts.reason ?? "done",
        cost: 0.001,
        tokens: opts.tokens ?? { input: 100, output: 20, reasoning: 5, cache: { read: 8 } },
      },
    });
  }

  function toolUse(opts: {
    callID: string;
    tool: string;
    input?: Record<string, unknown>;
    status?: string;
  }): string {
    return JSON.stringify({
      type: "tool_use",
      sessionID: "session_123",
      part: {
        tool: opts.tool,
        callID: opts.callID,
        state: { status: opts.status ?? "completed", input: opts.input ?? {} },
      },
    });
  }

  it("emits one chat_turn per step_finish with that step's usage and the configured model", async () => {
    const events: AdapterStreamEvent[] = [];
    const parser = createOpenCodeStreamEventParser((e) => {
      events.push(e);
    }, { model: "anthropic/claude-opus-4-8" });

    await parser.ingest(
      stepFinish({ reason: "tool_use", tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 8 } } }) + "\n",
    );
    await parser.ingest(
      stepFinish({ reason: "done", tokens: { input: 50, output: 12 } }) + "\n",
    );
    await parser.flush();

    const chatTurns = events.filter((e) => e.kind === "chat_turn");
    expect(chatTurns).toHaveLength(2);
    expect(chatTurns[0]).toMatchObject({
      kind: "chat_turn",
      model: "anthropic/claude-opus-4-8",
      turnIndex: 0,
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 25, cachedInputTokens: 8 },
    });
    expect(chatTurns[1]).toMatchObject({
      kind: "chat_turn",
      turnIndex: 1,
      stopReason: "done",
      usage: { inputTokens: 50, outputTokens: 12, cachedInputTokens: 0 },
    });
  });

  it("emits tool_call events classified as mcp, skill, and tool", async () => {
    const events: AdapterStreamEvent[] = [];
    const parser = createOpenCodeStreamEventParser((e) => {
      events.push(e);
    });

    await parser.ingest(toolUse({ callID: "c1", tool: "bash", input: { command: "ls" } }) + "\n");
    await parser.ingest(
      toolUse({ callID: "c2", tool: "mcp__mempalace__mempalace_search", input: { query: "x" } }) + "\n",
    );
    await parser.ingest(toolUse({ callID: "c3", tool: "Skill", input: { skill: "blog-write" } }) + "\n");
    await parser.flush();

    const toolCalls = events.filter((e) => e.kind === "tool_call");
    expect(toolCalls).toHaveLength(3);
    expect(toolCalls[0]).toMatchObject({ kind: "tool_call", call: { id: "c1", name: "bash", kind: "tool" } });
    expect(toolCalls[1]).toMatchObject({
      kind: "tool_call",
      call: { id: "c2", kind: "mcp", mcpServer: "mempalace" },
    });
    expect(toolCalls[2]).toMatchObject({
      kind: "tool_call",
      call: { id: "c3", kind: "skill", skillName: "blog-write" },
    });
  });

  it("dedupes a tool call repeated across its lifecycle by call id", async () => {
    const events: AdapterStreamEvent[] = [];
    const parser = createOpenCodeStreamEventParser((e) => {
      events.push(e);
    });

    await parser.ingest(toolUse({ callID: "dup", tool: "read", status: "pending", input: { path: "a" } }) + "\n");
    await parser.ingest(toolUse({ callID: "dup", tool: "read", status: "running", input: { path: "a" } }) + "\n");
    await parser.ingest(toolUse({ callID: "dup", tool: "read", status: "completed", input: { path: "a" } }) + "\n");
    await parser.flush();

    expect(events.filter((e) => e.kind === "tool_call")).toHaveLength(1);
  });

  it("reassembles JSON lines split across chunk boundaries", async () => {
    const events: AdapterStreamEvent[] = [];
    const parser = createOpenCodeStreamEventParser((e) => {
      events.push(e);
    });

    const line = stepFinish({ reason: "done" }) + "\n";
    const mid = Math.floor(line.length / 2);
    await parser.ingest(line.slice(0, mid));
    await parser.ingest(line.slice(mid));
    await parser.flush();

    expect(events.filter((e) => e.kind === "chat_turn")).toHaveLength(1);
  });

  it("prefers a stream-surfaced model over the configured fallback", async () => {
    const events: AdapterStreamEvent[] = [];
    const parser = createOpenCodeStreamEventParser((e) => {
      events.push(e);
    }, { model: "configured/model" });

    await parser.ingest(
      JSON.stringify({
        type: "step_finish",
        part: { reason: "done", modelID: "anthropic/claude-sonnet-4-6", tokens: { input: 1, output: 1 } },
      }) + "\n",
    );
    await parser.flush();

    const chatTurns = events.filter((e) => e.kind === "chat_turn");
    expect(chatTurns[0]).toMatchObject({ model: "anthropic/claude-sonnet-4-6" });
  });
});
