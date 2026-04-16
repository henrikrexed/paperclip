## Thinking Path

> - Paperclip orchestrates AI agents for zero-human companies
> - Operators of a Paperclip company need to see what their agents are doing — runs, tool calls, costs, governance, and delegation — with the same fidelity as any other production system
> - Today there is no first-party way to get traces, metrics, or structured logs out of Paperclip into an observability backend; operators have to scrape the activity log or build custom exporters
> - The plugin system already exposes the right events (agent runs, cost events, issue lifecycle, delegation, sessions), but nothing is packaging them into OpenTelemetry signals
> - This PR adds a batteries-included `paperclip-observability` plugin that subscribes to the plugin event bus and emits OTel traces, metrics, and logs via OTLP/HTTP to any compatible backend (Grafana, Datadog, Honeycomb, Tempo, etc.)
> - The benefit is that operators get production-grade agent observability — distributed traces across agent handoffs, per-agent health, token/cost metrics, and budget governance — by installing a single plugin

## Dependency

> **This PR depends on [#3750](https://github.com/paperclipai/paperclip/pull/3750).** The server-side event emission (heartbeat run lifecycle, cost events, agent delegation) is a prerequisite for this plugin. Merge #3750 first.

## What Changed

### Plugin Scaffold & SDK Setup
- New `plugins/paperclip-observability` package with manifest, worker lifecycle, and instance config schema.
- OTel SDK v2 initialization (`TracerProvider`, `MeterProvider`, `LoggerProvider`) via `otel-setup.ts` with OTLP/HTTP exporters and configurable flush intervals.

### Distributed Tracing
- Heartbeat run spans (`agent.run.started` → `finished`/`failed`) with agent name, run ID, and status.
- GenAI semantic-convention spans for LLM cost events (model, provider, token counts, cost).
- Issue lifecycle spans (create, status transitions, comments, delegation) keyed by identifier/project.
- Cross-agent trace linking via W3C `traceparent`/`tracestate` propagation so distributed traces span agent boundaries.
- Tool activity child spans nested under the parent run span for per-tool visibility.
- Ticket change child spans linked to their originating heartbeat run via direct `runId` lookup.
- Database query spans (table, operation, duration) for critical-path queries.
- Span hierarchy fixes: parent context fallbacks, payload field resolution, and run span context preservation for late-arriving cost events.

### Metrics
- GenAI token/cost counters (input/output tokens, total cost, per-model and per-provider).
- Agent health score gauge computed from success rate, latency, and error patterns.
- Issue/task flow counters (`created`, `completed`, `blocked`) with project and priority dimensions.
- Budget and governance gauges (monthly spend vs. budget, pause state, governance violations).
- Operation duration histograms with normalized provider names.
- Session streaming counters (chunk, status, done, error).
- Cardinality hygiene: normalized error dimensions, removed high-cardinality `project_name` from gauges.

### Structured Logging
- Activity log events routed through the telemetry framework and exported as OTel log records.
- Dedicated telemetry handlers for `activity.logged` events with business-context enrichment.
- Logs use `BatchLogRecordProcessor` so event handlers don't pay per-log OTLP round-trip latency.

### Health & Diagnostics
- Periodic server/DB health probes exposed as metrics.
- Composite agent health score exported as a gauge for alerting.

### Configuration
- Instance config: `otlpEndpoint`, `serviceName`, `enableTracing`, `enableMetrics`, `enableLogs`, `resourceAttributes`, `exportIntervalMs` (all optional with sensible defaults).
- `enableLogs` added to the instance config validation schema.
- `onConfigChanged` reinitializes the OTel SDK and refreshes the telemetry context so handlers always resolve the current `meter` / `tracer` / `otelLogger` instead of stale references from the previous SDK instance.

### Tests
- Worker lifecycle, metrics handlers, activity handlers, health scoring, shared OTel mocks.

## Verification

- Unit tests: `pnpm -C plugins/paperclip-observability test` (worker, metrics, activity, health score).
- Manual end-to-end trace test: ran the plugin against a local OTLP collector and confirmed heartbeat runs, cost events, issue lifecycle, delegation, and tool calls all appeared as a single connected trace across agent boundaries.
- Config reload test: triggered `onConfigChanged` mid-run and verified subsequent events were recorded on the new SDK instance (no silent loss after reload).
- Cardinality check: exported metrics to Prometheus and confirmed label sets are bounded (no high-cardinality `project_name` label; error metric labels are normalized).

## Risks

- **New dependency surface:** adds `@opentelemetry/*` v2 packages to the plugin's own package.json. No impact on core server dependencies.
- **OTLP exporter load:** if the configured OTLP endpoint is unreachable, the plugin uses batched export and drops with a warning rather than blocking the agent loop. Export intervals and batch sizes are configurable.
- **Trace cardinality:** span and metric attributes have been audited for cardinality; `project_name` was specifically removed from gauges. New high-cardinality dimensions should go through review before being added.
- **Plugin event bus coupling:** depends on the server-side emissions added in PR #3750. Running this plugin against an older server will no-op on the missing event types rather than erroring.

## Model Used

- Provider: Anthropic Claude
- Model ID: `claude-opus-4-6` (1M context window)
- Mode: extended thinking / tool use via Claude Code
- Role: drafted plugin scaffold, OTel setup, trace/metric/log/session handlers, and tests; paired with author on review

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [ ] If this change affects the UI, I have included before/after screenshots _(plugin-only PR; trace screenshot on #3750 shows output shape)_
- [x] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented any risks above
- [x] I will address all Greptile and reviewer comments before requesting merge
