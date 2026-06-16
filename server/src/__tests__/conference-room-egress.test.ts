/**
 * Conference-room span egress E2E — docker-free (ISI-1310 M6 verification).
 *
 * conference_room.chat.turn / .tool are SERVER spans emitted by the board-chat
 * relay (ISI-1307). In production the server runs under an external OTel
 * auto-instrumentation agent whose exporter ships these spans to the collector;
 * trace-context.ts only falls back to a NoopExporter when no such agent is
 * present. This test simulates that agent by registering a real capturing
 * TracerProvider as the global provider *before* trace-context lazily inits,
 * then proves both conference-room span names are actually exported.
 *
 * Pair this with plugins/paperclip-observability/tests/span-families.e2e.spec.ts
 * (the plugin-emitted families) for the full ISI-1310 M6 span-family set.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  type SpanExporter,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { withConferenceRoomSpan, startChildSpan } from "../services/trace-context.js";

class CapturingExporter implements SpanExporter {
  spans: ReadableSpan[] = [];
  export(spans: ReadableSpan[], cb: (r: { code: number }) => void): void {
    this.spans.push(...spans);
    cb({ code: 0 });
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  reset(): void {
    this.spans = [];
  }
}

const exporter = new CapturingExporter();

describe("conference-room span egress (ISI-1310 M6 / ISI-1307)", () => {
  beforeAll(() => {
    // Simulate the production OTel agent: register a real exporting provider as
    // the global one so trace-context.getTracer() routes spans here instead of
    // the no-op fallback.
    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ "service.name": "paperclip-server-e2e" }),
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });

  beforeEach(() => {
    exporter.reset();
  });

  it("exports a conference_room.chat.turn span", async () => {
    await withConferenceRoomSpan(
      { "paperclip.company.id": "co-1", "conference_room.model": "claude-opus-4" },
      async () => {
        /* one board-chat turn */
      },
    );

    const names = exporter.spans.map((s) => s.name);
    expect(names).toContain("conference_room.chat.turn");

    const turn = exporter.spans.find((s) => s.name === "conference_room.chat.turn")!;
    expect(turn.attributes["conference_room.model"]).toBe("claude-opus-4");
    // Valid (non-zero) trace id → real export, not the no-op provider.
    expect(turn.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(turn.spanContext().traceId).not.toBe("00000000000000000000000000000000");
  });

  it("exports a conference_room.chat.tool child sharing the turn trace", async () => {
    await withConferenceRoomSpan({ "paperclip.company.id": "co-2" }, async (span) => {
      const tool = startChildSpan(span, "conference_room.chat.tool", {
        "conference_room.tool.name": "Bash",
      });
      tool.end();
    });

    const turn = exporter.spans.find((s) => s.name === "conference_room.chat.turn")!;
    const tool = exporter.spans.find((s) => s.name === "conference_room.chat.tool")!;
    expect(turn, "turn span exported").toBeDefined();
    expect(tool, "tool span exported").toBeDefined();
    // Child tool span shares the turn's trace (one conference-room trace tree).
    expect(tool.spanContext().traceId).toBe(turn.spanContext().traceId);
  });
});
