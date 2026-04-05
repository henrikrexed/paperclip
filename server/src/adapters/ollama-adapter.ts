import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  ServerAdapterModule
} from "@paperclipai/adapter-utils";

export const ollamaAdapter: ServerAdapterModule = {
  type: "ollama_agent",

  async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    const { runId, agent, config, context, onLog, authToken } = ctx;

    const ollamaEndpoint = (config.endpoint as string) || "http://127.0.0.1:11434/api/chat";
    const model = (config.model as string) || "qwen3.5:35B";
    const systemPrompt = (config.systemPrompt as string) ||
      "You are a software engineer agent. You receive tickets and must resolve them thoroughly. " +
      "Analyze the ticket carefully, provide a complete solution including code if needed, " +
      "and summarize what you did.";
    const timeoutMs = (config.timeoutMs as number) || 600000;
    const paperclipApiUrl = (config.paperclipApiUrl as string) || "http://127.0.0.1:3100/api";

    await onLog("stdout", `[ollama-adapter] Starting run ${runId} for agent ${agent.name}\n`);

    // -------------------------------------------------------------------------
    // 1. Fetch full ticket context from Paperclip
    // -------------------------------------------------------------------------
    const taskId = context.taskId as string | undefined;
    let ticketContext = "";
    let ticketTitle = "Unknown";

    if (taskId) {
      try {
        await onLog("stdout", `[ollama-adapter] Fetching ticket context for ${taskId}\n`);
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

        const ctxRes = await fetch(`${paperclipApiUrl}/issues/${taskId}/heartbeat-context`, {
          headers,
          signal: AbortSignal.timeout(15000),
        });

        if (ctxRes.ok) {
          const ctxData = await ctxRes.json() as Record<string, unknown>;
          const issue = ctxData.issue as Record<string, unknown> | undefined;
          if (issue) {
            ticketTitle = (issue.title as string) || ticketTitle;
            const description = (issue.description as string) || "";
            const status = (issue.status as string) || "";
            const priority = (issue.priority as string) || "";
            ticketContext = `Ticket: ${ticketTitle}\nStatus: ${status}\nPriority: ${priority}\n\nDescription:\n${description}`;
          }
        } else {
          await onLog("stderr", `[ollama-adapter] Could not fetch ticket context: HTTP ${ctxRes.status}\n`);
        }
      } catch (e) {
        await onLog("stderr", `[ollama-adapter] Warning: failed to fetch ticket context: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }

    if (!ticketContext) {
      const wakeReason = (context.wakeReason as string) || "manual";
      ticketContext = `No specific ticket context available.\nWake reason: ${wakeReason}`;
    }

    await onLog("stdout", `[ollama-adapter] Ticket: ${ticketTitle}\n`);

    // -------------------------------------------------------------------------
    // 2. Call Ollama with full context
    // -------------------------------------------------------------------------
    const userMessage = `You have been assigned the following ticket. Please analyze it and provide a complete, actionable response.\n\n${ticketContext}`;

    await onLog("stdout", `[ollama-adapter] Calling ${model} at ${ollamaEndpoint}\n`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let ollamaResponse = "";
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const response = await fetch(ollamaEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = await response.text();
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: `Ollama returned HTTP ${response.status}: ${err}`,
          errorCode: "ollama_http_error",
        };
      }

      const result = await response.json() as Record<string, unknown>;
      const message = result.message as Record<string, unknown> | undefined;
      ollamaResponse = (message?.content as string) || "";
      inputTokens = (result.prompt_eval_count as number) || 0;
      outputTokens = (result.eval_count as number) || 0;

      await onLog("stdout", `[ollama-adapter] Inference done. Input tokens: ${inputTokens}, Output tokens: ${outputTokens}\n`);

    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        await onLog("stderr", `[ollama-adapter] Timed out after ${timeoutMs}ms\n`);
        return { exitCode: null, signal: null, timedOut: true, errorMessage: `Timeout after ${timeoutMs}ms`, errorCode: "timeout" };
      }
      const message = err instanceof Error ? err.message : String(err);
      await onLog("stderr", `[ollama-adapter] Ollama fetch error: ${message}\n`);
      return { exitCode: 1, signal: null, timedOut: false, errorMessage: message, errorCode: "ollama_fetch_error" };
    } finally {
      clearTimeout(timeout);
    }

    // -------------------------------------------------------------------------
    // 3. Update Paperclip ticket with result
    // -------------------------------------------------------------------------
    if (taskId && ollamaResponse) {
      try {
        await onLog("stdout", `[ollama-adapter] Posting result back to ticket ${taskId}\n`);
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "X-Paperclip-Run-Id": runId,
        };
        if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

        await fetch(`${paperclipApiUrl}/issues/${taskId}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            status: "done",
            comment: `## Completed by Ollama Agent (${model})\n\n${ollamaResponse}`,
          }),
          signal: AbortSignal.timeout(10000),
        });

        await onLog("stdout", `[ollama-adapter] Ticket marked as done.\n`);
      } catch (e) {
        await onLog("stderr", `[ollama-adapter] Warning: failed to update ticket: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      usage: { inputTokens, outputTokens },
      provider: "ollama",
      model,
      summary: `Completed ticket: ${ticketTitle}`,
      resultJson: { ticketId: taskId, response: ollamaResponse.slice(0, 500) },
    };
  },

  async testEnvironment(ctx) {
    const checks = [];
    const endpoint = ((ctx.config.endpoint as string) || "http://127.0.0.1:11434/api/chat")
      .replace("/api/chat", "/api/tags");

    try {
      const res = await fetch(endpoint, { method: "GET", signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json() as { models: unknown[] };
        checks.push({
          code: "ollama_reachable",
          level: "info" as const,
          message: `Ollama reachable — ${data.models?.length ?? 0} model(s) available`,
        });
      } else {
        checks.push({ code: "ollama_error", level: "warn" as const, message: `Ollama returned ${res.status}` });
      }
    } catch {
      checks.push({ code: "ollama_unreachable", level: "error" as const, message: "Ollama API not reachable" });
    }

    return {
      adapterType: "ollama_agent",
      status: checks.some(c => c.level === "error") ? "fail" : "pass",
      checks,
      testedAt: new Date().toISOString(),
    };
  },

  models: [
    { id: "qwen3.5:122B", label: "Qwen 3.5 122B (best quality)" },
    { id: "qwen3.5:35B", label: "Qwen 3.5 35B (recommended)" },
    { id: "qwen3.5:27b", label: "Qwen 3.5 27B" },
    { id: "qwen3:32b", label: "Qwen 3 32B" },
    { id: "llama3.3:70b", label: "Llama 3.3 70B" },
  ],

  agentConfigurationDoc: `# Ollama Agent Adapter

Adapter type: \`ollama_agent\`

This adapter connects any Ollama-hosted model to Paperclip. It fetches full ticket
context from the Paperclip API, sends it to the model, and posts the result back
as a comment, marking the ticket as done.

## Configuration

| Field             | Type    | Default                              | Description                        |
|-------------------|---------|--------------------------------------|------------------------------------|
| endpoint          | string  | http://127.0.0.1:11434/api/chat      | Ollama Chat API URL                |
| model             | string  | qwen3.5:35B                          | Ollama model name                  |
| systemPrompt      | string  | (see below)                          | Base behavior instructions         |
| timeoutMs         | number  | 600000                               | Inference timeout in ms            |
| paperclipApiUrl   | string  | http://127.0.0.1:3100/api            | Internal Paperclip API URL         |

## Recommended models
- \`qwen3.5:35B\` — Best balance of quality and speed for most tickets
- \`qwen3.5:122B\` — Highest quality, use for complex engineering tasks
`,
};
