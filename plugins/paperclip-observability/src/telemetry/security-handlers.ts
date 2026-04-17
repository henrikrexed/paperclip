/**
 * Security detection handlers — pattern-based threat detection on
 * activity.logged events.
 *
 * Ported from openclaw-o11y-plugin/src/security.ts (ISI-568). The three
 * pattern detections below inspect Paperclip activity events for known
 * threat patterns and emit:
 *
 *   - A `paperclip.security.event` span (child of the run/issue span)
 *     enriched with `paperclip.security.event.*` attributes for forensics.
 *   - Counters under `paperclip.security.*` for aggregate dashboarding /
 *     alerting (see `dynatrace/security-slo-dql.md` in the legacy repo).
 *   - A structured log (WARN/ERROR severity depending on detection severity)
 *     via ctx.otelLogger and the plugin logger.
 *
 * Detections:
 *   1. Sensitive file access — file paths matching credential / .env / .ssh
 *      patterns opened through tool actions (read, write, edit).
 *   2. Prompt injection — free-text tool input containing instruction-override
 *      patterns (e.g. "ignore previous instructions", "[SYSTEM]").
 *   3. Dangerous command execution — shell commands matching exfiltration,
 *      destructive, privilege-escalation, mining, or persistence patterns.
 *
 * Token-spike detection (legacy detection 4) is evaluated server-side in
 * Dynatrace against `paperclip.tokens.*` counters, not in this handler.
 */

import { SpanKind, SpanStatusCode, context, trace, type Context } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { TelemetryContext } from "./router.js";
import { parentCtxFromServerTrace } from "./trace-utils.js";
import { METRIC_NAMES, SECURITY_SPAN_NAME } from "../constants.js";

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------

/** Detection 1: Sensitive file patterns (credentials, keys, env files). */
const SENSITIVE_FILE_PATTERNS: readonly RegExp[] = [
  /\.env$/i,
  /\.env\./i,
  /openclaw\.json$/i,
  /paperclip\.json$/i,
  /\.ssh\//i,
  /id_rsa/i,
  /id_ed25519/i,
  /credentials/i,
  /\.aws\/credentials/i,
  /\.kube\/config/i,
  /\.docker\/config\.json/i,
  /\.netrc/i,
  /\.pgpass/i,
  /\.my\.cnf/i,
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
];

/** Detection 2: Prompt injection patterns. */
const PROMPT_INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+)?previous/i,
  /ignore\s+(your\s+)?instructions/i,
  /disregard\s+(all\s+)?prior/i,
  /forget\s+everything/i,
  /new\s+instructions/i,
  /\[SYSTEM\]/i,
  /\[ADMIN\]/i,
  /\[OVERRIDE\]/i,
  /SYSTEM:/i,
  /<<<\s*SYSTEM/i,
  /you\s+are\s+now\s+/i,
  /pretend\s+you\s+are/i,
  /act\s+as\s+if/i,
  /roleplay\s+as/i,
  /bypass\s+(your\s+)?(safety|security|restrictions)/i,
  /jailbreak/i,
  /DAN\s+mode/i,
];

interface DangerousCommandPattern {
  pattern: RegExp;
  severity: Severity;
  desc: string;
}

/** Detection 3: Dangerous command patterns with per-pattern severity. */
const DANGEROUS_COMMAND_PATTERNS: readonly DangerousCommandPattern[] = [
  // Data exfiltration
  { pattern: /\bcurl\b.*(-d|--data|-F|--form)/i, severity: "critical", desc: "curl with data upload" },
  { pattern: /\bcurl\b.*\|\s*(bash|sh|zsh)/i, severity: "critical", desc: "curl piped to shell" },
  { pattern: /\bwget\b.*-O\s*-\s*\|/i, severity: "critical", desc: "wget piped to shell" },
  { pattern: /\bnc\b.*-e/i, severity: "critical", desc: "netcat reverse shell" },
  { pattern: /\bnetcat\b/i, severity: "high", desc: "netcat usage" },

  // Destructive commands
  { pattern: /\brm\s+(-rf?|--recursive).*\//i, severity: "critical", desc: "recursive delete" },
  { pattern: /\brm\s+-rf?\s+\//i, severity: "critical", desc: "rm on root path" },
  { pattern: />\s*\/dev\/sd/i, severity: "critical", desc: "overwrite disk device" },
  { pattern: /\bmkfs\b/i, severity: "critical", desc: "filesystem format" },
  { pattern: /\bdd\b.*of=\/dev/i, severity: "critical", desc: "dd to device" },

  // Permission / privilege
  { pattern: /\bchmod\s+777\b/i, severity: "high", desc: "chmod 777 (world-writable)" },
  { pattern: /\bchmod\s+\+s\b/i, severity: "critical", desc: "setuid bit" },
  { pattern: /\bsudo\b/i, severity: "warning", desc: "sudo usage" },
  { pattern: /\bsu\s+-\s*$/i, severity: "warning", desc: "switch to root" },

  // Crypto / mining
  { pattern: /\bxmrig\b/i, severity: "critical", desc: "crypto miner" },
  { pattern: /stratum\+tcp/i, severity: "critical", desc: "mining pool connection" },

  // Persistence
  { pattern: /crontab\s+-e/i, severity: "high", desc: "crontab edit" },
  { pattern: /\/etc\/cron/i, severity: "high", desc: "cron directory access" },
  { pattern: /systemctl\s+(enable|start)/i, severity: "warning", desc: "systemd service modification" },
  { pattern: /\.bashrc|\.zshrc|\.profile/i, severity: "warning", desc: "shell profile modification" },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "critical" | "high" | "warning" | "info";

export type DetectionName =
  | "sensitive_file_access"
  | "prompt_injection"
  | "dangerous_command";

export interface SensitiveFileResult {
  detected: boolean;
  severity: Severity;
  pattern?: string;
}

export interface PromptInjectionResult {
  detected: boolean;
  severity: Severity;
  patterns: string[];
}

export interface DangerousCommandMatch {
  pattern: string;
  desc: string;
  severity: Severity;
}

export interface DangerousCommandResult {
  detected: boolean;
  severity: Severity;
  matches: DangerousCommandMatch[];
}

// ---------------------------------------------------------------------------
// Pure detection functions (exported for tests)
// ---------------------------------------------------------------------------

export function detectSensitiveFileAccess(filePath: string): SensitiveFileResult {
  if (!filePath) return { detected: false, severity: "info" };
  const normalized = filePath.toLowerCase();
  for (const pattern of SENSITIVE_FILE_PATTERNS) {
    if (pattern.test(normalized)) {
      return { detected: true, severity: "critical", pattern: pattern.source };
    }
  }
  return { detected: false, severity: "info" };
}

export function detectPromptInjection(message: string): PromptInjectionResult {
  if (!message) return { detected: false, severity: "info", patterns: [] };
  const matched: string[] = [];
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(message)) matched.push(pattern.source);
  }
  return {
    detected: matched.length > 0,
    severity: matched.length > 2 ? "critical" : "high",
    patterns: matched,
  };
}

export function detectDangerousCommand(command: string): DangerousCommandResult {
  if (!command) return { detected: false, severity: "info", matches: [] };
  const matches: DangerousCommandMatch[] = [];
  for (const { pattern, severity, desc } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      matches.push({ pattern: pattern.source, desc, severity });
    }
  }
  let highest: Severity = "info";
  if (matches.some((m) => m.severity === "critical")) highest = "critical";
  else if (matches.some((m) => m.severity === "high")) highest = "high";
  else if (matches.some((m) => m.severity === "warning")) highest = "warning";
  return { detected: matches.length > 0, severity: highest, matches };
}

// ---------------------------------------------------------------------------
// Activity-event extraction helpers
// ---------------------------------------------------------------------------

/** Tool names that may touch sensitive files. */
const FILE_TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "file.read",
  "file.write",
  "file.edit",
]);

/** Tool names that execute shell commands. */
const EXEC_TOOL_NAMES = new Set([
  "exec",
  "bash",
  "shell",
  "run",
  "tool.exec",
  "tool.bash",
  "tool.shell",
]);

/**
 * Extract a lowercased tool identifier from an activity.logged event.
 * Mirrors the activity-handlers `resolveToolName` logic but without the
 * fallback shape — returns empty string when the activity does not look
 * like a tool invocation.
 */
function activityToolName(action: string, entityType: string): string {
  if (entityType === "tool" || action.startsWith("tool.")) {
    return action.replace(/^tool\./, "").toLowerCase();
  }
  if (entityType === "file") return action.toLowerCase();
  return "";
}

/** Pull a file path out of the activity `details` blob. */
function activityFilePath(
  details: Record<string, unknown> | null,
  entityId: string,
): string {
  if (details) {
    const candidates = [
      details.filePath,
      details.file_path,
      details.path,
      (details.input as Record<string, unknown> | undefined)?.path,
      (details.input as Record<string, unknown> | undefined)?.file_path,
      (details.input as Record<string, unknown> | undefined)?.filePath,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.length > 0) return c;
    }
  }
  // Fall back to the activity entityId, which for file actions is the path.
  return entityId;
}

/** Pull a shell command string out of the activity `details` blob. */
function activityCommand(details: Record<string, unknown> | null): string {
  if (!details) return "";
  const candidates = [
    details.command,
    details.cmd,
    (details.input as Record<string, unknown> | undefined)?.command,
    (details.input as Record<string, unknown> | undefined)?.cmd,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return "";
}

/** Pull free-text input from the activity `details` blob (for prompt injection scanning). */
function activityTextInput(details: Record<string, unknown> | null): string {
  if (!details) return "";
  const candidates = [
    details.input,
    details.inputSummary,
    details.input_summary,
    details.message,
    details.prompt,
  ];
  for (const c of candidates) {
    if (typeof c === "string") return c;
  }
  // If input is an object, pick likely text fields
  const inputObj = details.input as Record<string, unknown> | undefined;
  if (inputObj) {
    for (const key of ["prompt", "message", "content", "text", "query"]) {
      const v = inputObj[key];
      if (typeof v === "string") return v;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Parent context resolution (copied pattern from activity-handlers)
// ---------------------------------------------------------------------------

async function resolveParentCtx(
  event: PluginEvent,
  ctx: TelemetryContext,
  runId: string,
): Promise<Context | undefined> {
  const parentSpan = runId ? ctx.activeRunSpans.get(runId) : undefined;
  if (parentSpan) return trace.setSpan(context.active(), parentSpan);

  const serverCtx = parentCtxFromServerTrace(event);
  if (serverCtx) return serverCtx;

  if (runId) {
    const stored = await ctx.state
      .get({ scopeKind: "instance", stateKey: `span:run:${runId}` })
      .catch(() => null);
    if (
      stored &&
      typeof stored === "object" &&
      "traceId" in (stored as Record<string, unknown>) &&
      "spanId" in (stored as Record<string, unknown>)
    ) {
      const s = stored as { traceId: string; spanId: string; traceFlags: number };
      return trace.setSpanContext(context.active(), {
        traceId: s.traceId,
        spanId: s.spanId,
        traceFlags: s.traceFlags ?? 1,
        isRemote: true,
      });
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Emission: span + counters + log
// ---------------------------------------------------------------------------

interface DetectionEmission {
  detection: DetectionName;
  severity: Severity;
  description: string;
  detailAttrs: Record<string, string | number | boolean>;
}

async function emitDetection(
  event: PluginEvent,
  ctx: TelemetryContext,
  emission: DetectionEmission,
  perDetectionMetric: keyof typeof METRIC_NAMES,
  perDetectionLabels: Record<string, string>,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const agentId = String(p.agentId ?? p.actorId ?? "");
  const agentName =
    String(p.agentName ?? "") || ctx.agentNameMap?.get(agentId) || "";
  const runId = String(p.runId ?? "");
  const companyId = String(p.companyId ?? event.companyId ?? "");

  // ---- Span: one paperclip.security.event per detection ----
  const parentCtx = await resolveParentCtx(event, ctx, runId);
  const tracer = agentId
    ? ctx.getTracerForAgent(agentId, agentName)
    : ctx.tracer;

  const spanAttrs: Record<string, string | number | boolean> = {
    "paperclip.security.event.detected": true,
    "paperclip.security.event.detection": emission.detection,
    "paperclip.security.event.severity": emission.severity,
    "paperclip.security.event.description": emission.description,
    "paperclip.agent.id": agentId,
    "paperclip.agent.name": agentName,
    "paperclip.company.id": companyId,
    "paperclip.run.id": runId,
    ...emission.detailAttrs,
  };

  const spanOpts = {
    kind: SpanKind.INTERNAL,
    attributes: spanAttrs,
  };

  const span = parentCtx
    ? tracer.startSpan(SECURITY_SPAN_NAME, spanOpts, parentCtx)
    : tracer.startSpan(SECURITY_SPAN_NAME, spanOpts);

  if (emission.severity === "critical" || emission.severity === "high") {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: `${emission.detection}: ${emission.description}`,
    });
  }

  span.addEvent("security.alert", {
    "paperclip.security.detection": emission.detection,
    "paperclip.security.severity": emission.severity,
  });

  span.end();

  // ---- Metrics: aggregate + per-detection counter ----
  const counter = ctx.meter.createCounter(METRIC_NAMES.securityEvents, {
    description: "Count of paperclip security detection events by type and severity",
  });
  counter.add(1, {
    detection: emission.detection,
    severity: emission.severity,
    agent_id: agentId,
    company_id: companyId,
  });

  const perDetectionCounter = ctx.meter.createCounter(
    METRIC_NAMES[perDetectionMetric],
    { description: `Count of ${emission.detection} security detections` },
  );
  perDetectionCounter.add(1, perDetectionLabels);

  // ---- Log: structured WARN (warning) or ERROR (high/critical) ----
  const severityText =
    emission.severity === "critical" || emission.severity === "high"
      ? "ERROR"
      : "WARN";
  const severityNumber =
    emission.severity === "critical"
      ? SeverityNumber.FATAL
      : emission.severity === "high"
        ? SeverityNumber.ERROR
        : SeverityNumber.WARN;

  const logAttrs: Record<string, string | number> = {
    "paperclip.event.type": "security.detection",
    "paperclip.security.event.detection": emission.detection,
    "paperclip.security.event.severity": emission.severity,
    "paperclip.security.event.description": emission.description,
    "paperclip.agent.id": agentId,
    "paperclip.run.id": runId,
    "paperclip.company.id": companyId,
  };
  // Flatten string detail attrs into the log (drop booleans/numbers for body).
  for (const [k, v] of Object.entries(emission.detailAttrs)) {
    if (typeof v === "string" || typeof v === "number") logAttrs[k] = v;
  }

  const body = `Security: ${emission.detection} (${emission.severity}) — ${emission.description}`;

  if (ctx.otelLogger) {
    ctx.otelLogger.emit({
      severityText,
      severityNumber,
      body,
      attributes: logAttrs,
    });
  }

  const logFn =
    severityText === "ERROR" ? ctx.logger.error : ctx.logger.warn;
  logFn.call(ctx.logger, body, logAttrs);
}

// ---------------------------------------------------------------------------
// Handler: activity.logged → run all three pattern detections
// ---------------------------------------------------------------------------

/**
 * Inspect an `activity.logged` event for the 3 pattern-based security
 * detections and emit one span + counter + log per detection that fires.
 *
 * No-op when the activity payload does not look like a tool invocation or
 * carries no relevant input.
 */
export async function handleActivitySecurity(
  event: PluginEvent,
  ctx: TelemetryContext,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const action = String(p.action ?? "");
  const entityType = String(p.entityType ?? "");
  const entityId = String(p.entityId ?? "");
  const details = (p.details as Record<string, unknown> | null) ?? null;

  const toolName = activityToolName(action, entityType);
  if (!toolName) return;

  // Detection 1: Sensitive file access (Read, Write, Edit tool calls)
  if (FILE_TOOL_NAMES.has(toolName)) {
    const filePath = activityFilePath(details, entityId);
    if (filePath) {
      const result = detectSensitiveFileAccess(filePath);
      if (result.detected) {
        await emitDetection(
          event,
          ctx,
          {
            detection: "sensitive_file_access",
            severity: result.severity,
            description: `Access to sensitive file: ${filePath}`,
            detailAttrs: {
              "paperclip.security.event.tool": toolName,
              "paperclip.security.event.file_path": filePath.slice(0, 512),
              "paperclip.security.event.matched_pattern":
                result.pattern ?? "unknown",
            },
          },
          "securitySensitiveFileAccess",
          { file_pattern: result.pattern ?? "unknown" },
        );
      }
    }
  }

  // Detection 3: Dangerous command (exec / bash / shell tool calls)
  if (EXEC_TOOL_NAMES.has(toolName)) {
    const command = activityCommand(details);
    if (command) {
      const result = detectDangerousCommand(command);
      if (result.detected) {
        const firstDesc = result.matches[0]?.desc ?? "unknown";
        await emitDetection(
          event,
          ctx,
          {
            detection: "dangerous_command",
            severity: result.severity,
            description: result.matches.map((m) => m.desc).join(", "),
            detailAttrs: {
              "paperclip.security.event.tool": toolName,
              "paperclip.security.event.command": command.slice(0, 500),
              "paperclip.security.event.match_count": result.matches.length,
              "paperclip.security.event.first_match": firstDesc,
            },
          },
          "securityDangerousCommand",
          { command_type: firstDesc },
        );
      }
    }
  }

  // Detection 2: Prompt injection — scan any free-text input carried on the
  // activity (applies across tools, not just file/exec). Guard against empty
  // strings so we never evaluate patterns on zero-length messages.
  const textInput = activityTextInput(details);
  if (textInput) {
    const result = detectPromptInjection(textInput);
    if (result.detected) {
      await emitDetection(
        event,
        ctx,
        {
          detection: "prompt_injection",
          severity: result.severity,
          description: `Potential prompt injection: ${result.patterns.length} pattern(s) matched`,
          detailAttrs: {
            "paperclip.security.event.tool": toolName,
            "paperclip.security.event.pattern_count": result.patterns.length,
            "paperclip.security.event.message_preview": textInput.slice(0, 200),
          },
        },
        "securityPromptInjection",
        { pattern_count: String(result.patterns.length) },
      );
    }
  }
}
