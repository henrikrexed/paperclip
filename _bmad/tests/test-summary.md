# Test Summary

## ISI-1311 — Validate live OTLP-egress parent span family (ISI-1304 acceptance)

**Date:** 2026-06-16 · **Branch:** `feat/fork-upgrade-strategy-c-20260615` · **Author:** Testing Architect (Amelia)

### Acceptance under test
ISI-1304 acceptance item: *"OTLP-egress E2E shows the parent span family."*
- `paperclip.heartbeat.run` parent span is exported.
- `cost_event.created`, `issue.comment.created`, `agent.run.finished` appear trace-linked under the **same trace** (shared `traceId`).

### New test
`plugins/paperclip-observability/tests/trace-family.e2e.spec.ts` — docker-free.

Drives the **real** trace handlers (`handleRunStartedTraces`, `handleCostTraces`,
`handleIssueCommentCreatedTraces`, `handleRunFinishedTraces`) through a **real**
OTel `NodeSDK`. A custom span exporter (a) captures finished spans for structural
assertions and (b) forwards them to an `OTLPTraceExporter` posting OTLP/proto to an
in-process receiver — proving the family both forms correctly and egresses on the wire.

Asserts, with a server-propagated `traceContext` injected on the run.started event
(the ISI-1304 keystone, `server/src/services/trace-context.ts` →
`PluginEvent.traceContext`):
- `paperclip.heartbeat.run` is exported, `traceId == server traceId`, `parentSpanId == server spanId` (true distributed linkage).
- cost span `chat <model>` shares the trace and is a child of the run span (`parentSpanId == run.spanId`).
- `issue.comment.created` is recorded as a span event on the run span.
- `agent.run.finished` closes the run span `OK` with `paperclip.run.exit_code`.
- Every exported span shares the one server-rooted `traceId`.
- OTLP/proto wire body contains `paperclip.heartbeat.run` and the raw server trace-id bytes.

### Results — 100% green
| Suite | Result |
|-------|--------|
| `plugins/paperclip-observability/tests/**` (incl. new family E2E + existing otlp-egress E2E) | 7 files, **75 passed** |
| `server/src/__tests__/trace-context-propagation.test.ts` | **3 passed** |

Run command (plugins dir is not a root vitest project — runs standalone):
`npx vitest run --root plugins/paperclip-observability --config <tmp config with include tests/**/*.spec.ts>`

### Live path corroboration (non-invasive)
Server, otel-collector (`otelcol-contrib`, PID 1093, config `otel-collector-config.yaml`),
and the observability plugin worker are all running. Collector `debug` exporter (basic
verbosity) logs confirm **33 trace export batches on 2026-06-16**, several with 3 spans
per resource — consistent with a parent + children span family egressing live to the
collector (then on to Dynatrace via `otlphttp/dynatrace`).

Full live **family-structure** inspection (span names + shared traceId + parent links on
the wire) requires flipping the collector `debug` verbosity to `detailed` — a shared
production-telemetry config change not made unilaterally. The docker-free E2E above is the
authoritative, deterministic proof of the family contract.
