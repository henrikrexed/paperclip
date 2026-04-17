# Paperclip Security SLO & Detection DQL Queries

> Companion reference for the security detection handler in
> `src/telemetry/security-handlers.ts`. All queries target the
> `paperclip.security.*` metric namespace and the
> `paperclip.security.event` span name emitted by that handler.
>
> The legacy OpenClaw Gateway's security surface (`openclaw.security.*`)
> is documented in `openclaw-o11y-plugin/dynatrace/security-slo-dql.md`
> and stays on that namespace.

## Detection 1: Sensitive File Access

### Dashboard Query — Events Over Time
```dql
timeseries count = sum(paperclip.security.sensitive_file_access), by:{file_pattern}
| fieldsRename pattern = file_pattern
```

### SLO Query — No sensitive file access in time window
```dql
timeseries events = sum(paperclip.security.sensitive_file_access)
| fieldsAdd slo_met = events == 0
| summarize slo_percentage = 100 * countIf(slo_met) / count()
```

### Alert Query — Immediate detection
```dql
timeseries events = sum(paperclip.security.sensitive_file_access)
| filter events > 0
| summarize total = sum(events)
| filter total > 0
```

### Span Query — Detailed forensics
```dql
fetch spans
| filter span.name == "paperclip.security.event"
| filter paperclip.security.event.detection == "sensitive_file_access"
| fields timestamp, paperclip.security.event.severity, paperclip.security.event.description, paperclip.agent.id, paperclip.run.id, paperclip.security.event.file_path
| sort timestamp desc
| limit 100
```

---

## Detection 2: Prompt Injection

### Dashboard Query — Injection attempts over time
```dql
timeseries count = sum(paperclip.security.prompt_injection), by:{pattern_count}
```

### SLO Query — No prompt injection attempts
```dql
timeseries events = sum(paperclip.security.prompt_injection)
| fieldsAdd slo_met = events == 0
| summarize slo_percentage = 100 * countIf(slo_met) / count()
```

### Alert Query — Immediate detection
```dql
timeseries events = sum(paperclip.security.prompt_injection)
| filter events > 0
| summarize total = sum(events)
| filter total > 0
```

### Span Query — Detailed forensics
```dql
fetch spans
| filter span.name == "paperclip.security.event"
| filter paperclip.security.event.detection == "prompt_injection"
| fields timestamp, paperclip.security.event.severity, paperclip.security.event.description, paperclip.agent.id, paperclip.run.id, paperclip.security.event.message_preview
| sort timestamp desc
| limit 100
```

---

## Detection 3: Dangerous Command Execution

### Dashboard Query — Commands by type
```dql
timeseries count = sum(paperclip.security.dangerous_command), by:{command_type}
| fieldsRename type = command_type
```

### SLO Query — No dangerous commands
```dql
timeseries events = sum(paperclip.security.dangerous_command)
| fieldsAdd slo_met = events == 0
| summarize slo_percentage = 100 * countIf(slo_met) / count()
```

### Alert Query — Immediate detection
```dql
timeseries events = sum(paperclip.security.dangerous_command)
| filter events > 0
| summarize total = sum(events)
| filter total > 0
```

### Span Query — Detailed forensics
```dql
fetch spans
| filter span.name == "paperclip.security.event"
| filter paperclip.security.event.detection == "dangerous_command"
| fields timestamp, paperclip.security.event.severity, paperclip.security.event.description, paperclip.agent.id, paperclip.run.id, paperclip.security.event.command, paperclip.security.event.first_match
| sort timestamp desc
| limit 100
```

---

## Detection 4: Token Spike Anomaly

> Paperclip tokens live under `gen_ai.client.token.usage` (histogram) and
> the paperclip counters `paperclip.tokens.input` / `paperclip.tokens.output`.
> There is no dedicated `paperclip.llm.tokens.total` metric; compose it
> from the two counters. This detection is evaluated server-side in
> Dynatrace and has no handler-emitted counter or span.

### Dashboard Query — Token usage trend with baseline
```dql
timeseries {
  current = sum(paperclip.tokens.input) + sum(paperclip.tokens.output),
  baseline = sum(paperclip.tokens.input, shift:-1d) + sum(paperclip.tokens.output, shift:-1d)
}, by:{model}
| fieldsAdd spike_ratio = if(baseline > 0, current / baseline, 0)
```

### SLO Query — Usage within 3x of baseline
```dql
timeseries {
  current = sum(paperclip.tokens.input) + sum(paperclip.tokens.output),
  baseline = sum(paperclip.tokens.input, shift:-1d) + sum(paperclip.tokens.output, shift:-1d)
}
| fieldsAdd spike_ratio = if(baseline > 0, current / baseline, 1)
| fieldsAdd slo_met = spike_ratio <= 3
| summarize slo_percentage = 100 * countIf(slo_met) / count()
```

### Alert Query — Spike detected
```dql
timeseries {
  current = sum(paperclip.tokens.input) + sum(paperclip.tokens.output),
  baseline = sum(paperclip.tokens.input, shift:-1d) + sum(paperclip.tokens.output, shift:-1d)
}
| fieldsAdd spike_ratio = if(baseline > 0, current / baseline, 0)
| filter spike_ratio > 3
| summarize alert_count = count()
| filter alert_count > 0
```

### Span Query — High token usage requests
```dql
fetch spans
| filter span.name matches "chat .*"
| fields timestamp, gen_ai.request.model, gen_ai.usage.input_tokens, gen_ai.usage.output_tokens, paperclip.cost.cents, paperclip.agent.id
| fieldsAdd total_tokens = gen_ai.usage.input_tokens + gen_ai.usage.output_tokens
| filter total_tokens > 10000
| sort total_tokens desc
| limit 50
```

---

## Combined Security Dashboard

### All Security Events
```dql
timeseries {
  file_access = sum(paperclip.security.sensitive_file_access),
  injection = sum(paperclip.security.prompt_injection),
  dangerous_cmd = sum(paperclip.security.dangerous_command)
}
```

### Security Events by Severity (from spans)
```dql
fetch spans
| filter span.name == "paperclip.security.event"
| filter paperclip.security.event.detected == true
| summarize count = count(), by:{paperclip.security.event.severity, paperclip.security.event.detection}
| sort count desc
```

### Recent Security Incidents
```dql
fetch spans
| filter span.name == "paperclip.security.event"
| filter paperclip.security.event.detected == true
| fields timestamp, paperclip.security.event.detection, paperclip.security.event.severity, paperclip.security.event.description, paperclip.agent.id, paperclip.run.id
| sort timestamp desc
| limit 20
```

### Security Posture Score (SLO %)
```dql
timeseries total_events = sum(paperclip.security.events)
| summarize total = sum(total_events)
| fieldsAdd posture = if(total == 0, "Secure", "Events Detected")
```

---

## Setting Up Metric Events (Alerts)

In Dynatrace: **Settings → Anomaly Detection → Metric Events**

### 1. Sensitive File Access Alert
```yaml
Name: Paperclip - Sensitive File Access
Metric: paperclip.security.sensitive_file_access:count
Aggregation: Sum
Condition: > 0
Evaluation: 1 minute
Severity: Critical
```

### 2. Prompt Injection Alert
```yaml
Name: Paperclip - Prompt Injection Attempt
Metric: paperclip.security.prompt_injection:count
Aggregation: Sum
Condition: > 0
Evaluation: 1 minute
Severity: High
```

### 3. Dangerous Command Alert
```yaml
Name: Paperclip - Dangerous Command Execution
Metric: paperclip.security.dangerous_command:count
Aggregation: Sum
Condition: > 0
Evaluation: 1 minute
Severity: High
```

### 4. Token Spike Alert
```yaml
Name: Paperclip - Token Usage Spike
Metric: paperclip.tokens.output:rate
Aggregation: Avg
Condition: > 3x baseline (auto-adaptive)
Evaluation: 5 minutes
Severity: Warning
```

---

## Setting Up SLOs

In Dynatrace: **Service Level Objectives → Create SLO**

### Security SLO: Zero Critical Events
```yaml
Name: Paperclip Security - Zero Critical Events
Type: Metric-based
Metric: paperclip.security.events
Filter: severity = "critical"
Target: 100% (zero events)
Warning: 99%
Timeframe: 7 days
```

### Operational SLO: Token Budget
```yaml
Name: Paperclip - Token Budget Compliance
Type: Metric-based
Evaluation: Custom DQL
Target: 95% of time within 3x baseline
Warning: 90%
Timeframe: 30 days
```
