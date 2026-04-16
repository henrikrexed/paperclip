## Thinking Path

> - Paperclip orchestrates AI agents for zero-human companies
> - Agents run through adapters that bridge Paperclip's run lifecycle to a specific model provider or CLI
> - Today we ship adapters for Claude, Codex, Gemini, Cursor, OpenClaw, Hermes, Pi, and OpenCode — but nothing for locally-hosted Ollama models
> - Teams running on-prem or offline can't put a local Qwen, Llama, or Mistral model behind a Paperclip agent without writing their own adapter
> - This PR adds a first-class `ollama_agent` adapter that drives any tool-calling Ollama model through the full Paperclip agent loop (list / checkout / complete / comment) with optional sandboxed filesystem tools
> - The benefit is that local-model operators get the same agent ergonomics as cloud-model operators, with the same budget and governance guarantees

## What Changed

- `server/src/adapters/ollama-adapter.ts`: full adapter implementation — Ollama `/api/chat` tool-calling loop with Paperclip API integration (list tasks, get heartbeat context, checkout, complete, comment), streaming response handling, tool-call accumulation, and a hard iteration cap (`MAX_TOOL_ITERATIONS = 20`) to prevent runaway loops.
- `server/src/adapters/registry.ts`: register `ollamaAdapter` alongside existing built-in adapters so it ships by default.
- `server/src/adapters/builtin-adapter-types.ts`: add `"ollama_agent"` to `BUILTIN_ADAPTER_TYPES` so the adapter is protected from external unregistration and overrides are logged like all other built-ins.
- Config knobs: `baseUrl` (default `http://localhost:11434`), `model` (default `qwen3.5:35B`), `endpoint`, `timeoutSec` (default 600), `systemPrompt`, `useTools`, `options` for extra Ollama runtime options.
- System prompt is sent as a `system`-role message so tool-calling models follow instructions correctly (Ollama honors the `system` role and the `OllamaMessage` type already supported it).
- Filesystem tools (`read_file`, `write_file`, `list_directory`) are **opt-in** via `enableFilesystem: true` and sandboxed to a configurable `workspaceDir` (absolute resolve + prefix check), so LLM-generated paths cannot escape the workspace.
- Registered adapter type: `ollama_agent`.

## Verification

- Unit tests: `pnpm -C server test server/src/adapters/ollama-adapter` cover tool-loop iteration limits, path sandbox enforcement, and config fallbacks.
- Local smoke test: ran a task end-to-end against `ollama serve` on `localhost:11434` with `qwen3.5:35B`. Agent successfully listed tasks, checked one out, completed it, and posted a comment — full heartbeat lifecycle.
- Path sandbox test: asked the model to read `/etc/passwd`; tool call was rejected with a `path traversal denied` error. Confirmed reads/writes only succeed under the configured `workspaceDir`.
- Adapter type protection: `unregisterServerAdapter("ollama_agent")` now returns early (built-in guard), and overriding the type logs the built-in override warning.

## Risks

- **New network dependency:** the adapter talks to an Ollama HTTP endpoint. If misconfigured (`baseUrl` wrong, Ollama not running), the agent fails loudly per heartbeat with an HTTP error — no silent failures.
- **Filesystem tools:** disabled by default. When opted in, paths are resolved and checked against `workspaceDir` before any I/O. Operators can leave `enableFilesystem` off and use only the Paperclip-API tools.
- **Tool-call iteration cap:** hard limit of 20 iterations prevents runaway loops on pathological models; in practice most tasks finish in under 5.
- **Model compatibility:** adapter requires a tool-calling-capable Ollama model (qwen3.5, llama3.3, mistral-nemo, etc.). Non-tool-calling models will fail the first chat call — documented in the adapter comment header.

## Model Used

- Provider: Anthropic Claude
- Model ID: `claude-opus-4-6` (1M context window)
- Mode: extended thinking / tool use via Claude Code
- Role: drafted adapter implementation, tool dispatcher, and sandbox logic; paired with author on review

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [ ] If this change affects the UI, I have included before/after screenshots _(server-only PR)_
- [x] I have updated relevant documentation to reflect my changes
- [x] I have considered and documented any risks above
- [x] I will address all Greptile and reviewer comments before requesting merge
