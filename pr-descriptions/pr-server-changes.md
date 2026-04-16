## Thinking Path

> - Paperclip orchestrates AI agents for zero-human companies
> - Plugins are the extension surface for new capabilities like observability, billing, or governance
> - Plugins need visibility into the agent lifecycle (run start/finish/fail), cost events, and agent-to-agent delegation so they can build accurate traces, dashboards, and audit trails
> - Today several of these signals are either not emitted at all (delegation, heartbeat run lifecycle) or only wired to a single HTTP route (cost events), so plugins can't see them reliably
> - This PR moves those signals into services and emits them onto the plugin event bus, and makes the orphaned-run reaper threshold explicit instead of implicit
> - The benefit is a stable, plugin-facing event surface that the observability plugin (PR #3752) and future plugins can consume without coupling to route handlers

## What Changed

- `server/src/services/heartbeat.ts`: emit `agent.run.started` on run claim and `agent.run.finished` / `agent.run.failed` / `agent.run.cancelled` on status transitions via `logActivity`, consistent with the rest of the service (ISI-264).
- `server/src/services/costs.ts`: move `cost_event.created` emission out of the costs route and into the cost service; forward the event to the plugin bus with full payload (model, tokens, provider, billing type) so every cost event — regardless of entry point — reaches plugins (ISI-269, ISI-284).
- `server/src/routes/costs.ts`: drop the now-redundant emission from the HTTP route (service handles it).
- `server/src/routes/issues.ts`: emit `agent.delegation.created` on issue reassignment and on subtask creation during an active agent run. Enables explicit multi-agent trace trees without heuristic inference.
- `packages/shared/src/constants.ts`: register `agent.delegation.created` in `PLUGIN_EVENT_TYPES` so plugin bus subscribers and the activity log validator both recognize it.
- `server/src/index.ts`: pass an explicit `staleThresholdMs` to `reapOrphanedRuns` (2 min startup, 5 min periodic) instead of relying on the implicit default.
- `packages/shared/src/index.ts`: remove stale `dist/` export paths that pointed at files no longer produced by the build.

## Verification

- Unit tests: `pnpm -C server test` (heartbeat service, cost service, issues route).
- Manual trace validation: ran the observability plugin (PR #3752) against this branch and confirmed heartbeat run spans, cost spans, and delegation spans all appeared end-to-end.
- Trace screenshot captured below shows run → tool → cost spans nested correctly and delegation links surviving agent handoffs.
- Smoke test of cost entry points: triggered cost events both from the HTTP route and from in-process billing to confirm the plugin bus receives a single, well-formed `cost_event.created` event from either path.

Trace captured with the observability plugin against this branch:

<img width="1407" height="893" alt="image" src="https://github.com/user-attachments/assets/2884e826-f5c2-4734-a79e-fd105c332957" />

## Risks

- **Activity log growth:** cost events now flow through `logActivity`, which inserts a row into `activityLog`. On a busy instance this table will grow at roughly one row per LLM call. Mitigation plan: a retention/pruning policy for `cost_event.created` rows in a follow-up; emission itself is fire-and-forget so request latency is unaffected.
- **Event surface:** plugins that previously relied on the costs route for `cost_event.created` are unaffected — the event shape is preserved. New `agent.run.*` and `agent.delegation.created` types are additive.
- **Reaper threshold:** explicit thresholds match the previous implicit defaults, so behavior is unchanged for existing deployments.

## Model Used

- Provider: Anthropic Claude
- Model ID: `claude-opus-4-6` (1M context window)
- Mode: extended thinking / tool use via Claude Code
- Role: drafted the heartbeat/cost/delegation emission code, paired with author on review

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [ ] If this change affects the UI, I have included before/after screenshots _(server-only PR, trace screenshot included instead)_
- [x] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented any risks above
- [x] I will address all Greptile and reviewer comments before requesting merge
