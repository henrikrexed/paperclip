import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  ServerAdapterModule
} from "@paperclipai/adapter-utils";

export const ollamaAdapter: ServerAdapterModule = {
  type: "ollama_agent",

  async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    const { runId, agent, config, context, onLog } = ctx;

    const endpoint = (config.endpoint as string) || "http://localhost:11434/api/chat";
    const model = (config.model as string) || "qwen3.5:122B";
    const systemPrompt = (config.systemPrompt as string) || "You are a helpful AI agent.";
    const timeoutMs = (config.timeoutMs as number) || 120000;

    await onLog("stdout", `[ollama-adapter] Invoking ${model} at ${endpoint}\n`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const messages = [
        { role: "system", content: systemPrompt },
        { 
          role: "user", 
          content: `Task ID: ${context.taskId || 'Unknown'}\nReason: ${context.wakeReason || 'Unknown'}\nPlease handle the assigned ticket.` 
        }
      ];

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model,
          messages: messages,
          stream: false
        }),
        signal: controller.signal,
      });

      const result = await response.json();

      if (!response.ok) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: `Ollama Error: ${result.error || response.statusText}`,
          errorCode: "ollama_error",
          resultJson: result,
        };
      }

      await onLog("stdout", `[ollama-adapter] Inference complete.\n`);

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        usage: {
          inputTokens: result.prompt_eval_count || 0,
          outputTokens: result.eval_count || 0,
        },
        provider: "ollama",
        model: result.model,
        summary: "Agent run completed via Ollama",
        resultJson: result,
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        await onLog("stderr", `[ollama-adapter] Timed out after ${timeoutMs}ms\n`);
        return {
          exitCode: null,
          signal: null,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutMs}ms`,
          errorCode: "timeout",
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      await onLog("stderr", `[ollama-adapter] Error: ${message}\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: message,
        errorCode: "request_failed",
      };
    } finally {
      clearTimeout(timeout);
    }
  },

  async testEnvironment(ctx) {
    const checks = [];
    const endpoint = (ctx.config.endpoint as string) || "http://localhost:11434/api/tags";
    
    try {
      const response = await fetch(endpoint, { method: "GET", signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        checks.push({ code: "ollama_reachable", level: "info" as const, message: "Ollama API is reachable" });
      } else {
        checks.push({ code: "ollama_error", level: "warn" as const, message: `Ollama returned ${response.status}` });
      }
    } catch (err) {
      checks.push({ code: "ollama_unreachable", level: "error" as const, message: "Could not reach Ollama API" });
    }

    return {
      adapterType: "ollama_agent",
      status: checks.some(c => c.level === "error") ? "fail" : "pass",
      checks,
      testedAt: new Date().toISOString(),
    };
  },

  models: [
    { id: "qwen3.5:122B", label: "Qwen 3.5 122B" },
    { id: "qwen3:32b", label: "Qwen 3 32B" },
    { id: "llama3.3:70b", label: "Llama 3.3 70B" }
  ],

  agentConfigurationDoc: `# Ollama Agent configuration

Adapter: ollama_agent

Core fields:
- endpoint (string, optional): Ollama Chat API endpoint (default: http://localhost:11434/api/chat)
- model (string, optional): Model name (default: qwen3.5:122B)
- systemPrompt (string, optional): Base behavior instructions
- timeoutMs (number, optional): Request timeout in milliseconds (default: 120000)
`,
};
