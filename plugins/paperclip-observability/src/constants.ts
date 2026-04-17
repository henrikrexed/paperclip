export const PLUGIN_ID = "paperclip.observability";
export const PLUGIN_VERSION = "0.1.0";

export const JOB_KEYS = {
  collectMetrics: "collect-metrics",
} as const;

export const METRIC_NAMES = {
  agentRunDuration: "paperclip.agent.run.duration_ms",
  agentRunErrors: "paperclip.agent.run.errors",
  agentRunsStarted: "paperclip.agent.runs.started",
  tokensInput: "paperclip.tokens.input",
  tokensOutput: "paperclip.tokens.output",
  costCents: "paperclip.cost.cents",
  issuesCreated: "paperclip.issues.created",
  issueTransitions: "paperclip.issue.transitions",
  agentStatusChanges: "paperclip.agent.status_changes",
  approvalsCreated: "paperclip.approvals.created",
  approvalsDecided: "paperclip.approvals.decided",
  approvalDecisionTime: "paperclip.approval.decision_time_ms",
  issuesCompleted: "paperclip.issues.completed",
  eventsTotal: "paperclip.events.total",

  // Gauge metrics (scheduled job)
  agentsCount: "paperclip.agents.count",
  issuesCount: "paperclip.issues.count",
  agentsHeartbeatAge: "paperclip.agents.heartbeat.age_seconds",
  budgetUtilization: "paperclip.budget.utilization",
  budgetRemaining: "paperclip.budget.remaining_cents",

  // Budget & governance gauges (scheduled job)
  approvalsPending: "paperclip.approvals.pending",
  budgetIncidentsActive: "paperclip.budget.incidents.active",
  companyBudgetUtilization: "paperclip.budget.company.utilization",
  budgetPausedAgents: "paperclip.budget.paused_agents",
  budgetPausedProjects: "paperclip.budget.paused_projects",

  // Health scoring gauges (scheduled job)
  agentHealthScore: "paperclip.agent.health.score",

  // Server health gauge (scheduled job)
  serverHealthScore: "paperclip.health.server.score",

  // Project-level metrics
  projectTokensInput: "paperclip.project.tokens.input",
  projectTokensOutput: "paperclip.project.tokens.output",
  projectCostCents: "paperclip.project.cost.cents",

  // Issue-level metrics
  issueTokensInput: "paperclip.issue.tokens.input",
  issueTokensOutput: "paperclip.issue.tokens.output",

  // Session streaming metrics
  sessionDuration: "paperclip.agent.session.duration_ms",
  sessionTtft: "paperclip.agent.session.ttft_ms",
  sessionChunks: "paperclip.agent.session.chunks",
  sessionErrors: "paperclip.agent.session.errors",

  // Activity observability metrics
  activityCount: "paperclip.agent.activity.count",
  activityActorCount: "paperclip.agent.activity.actor_count",

  // Comment metrics
  issueCommentsCreated: "paperclip.issue.comments.created",

  // Database instrumentation metrics
  dbQueryDuration: "paperclip.db.query.duration_ms",
  dbQueryErrors: "paperclip.db.query.errors",

  // Security detection metrics (ported from openclaw-o11y-plugin/src/security.ts
  // for ISI-568). Emitted by telemetry/security-handlers.ts when any of the 3
  // pattern-based detections fire on activity.logged events. Token-spike
  // (legacy detection 4) is evaluated server-side in Dynatrace against
  // paperclip.tokens.* counters and has no dedicated metric here.
  securityEvents: "paperclip.security.events",
  securitySensitiveFileAccess: "paperclip.security.sensitive_file_access",
  securityPromptInjection: "paperclip.security.prompt_injection",
  securityDangerousCommand: "paperclip.security.dangerous_command",
} as const;

/**
 * Span name emitted by the paperclip-observability security module.
 *
 * One `paperclip.security.event` span is produced per detection hit, with
 * attributes under `paperclip.security.event.*`. OTel semconv has no
 * standardized security-event schema yet; stay in the paperclip.* namespace
 * and document the contract in `dynatrace/security-slo-dql.md`.
 */
export const SECURITY_SPAN_NAME = "paperclip.security.event";
