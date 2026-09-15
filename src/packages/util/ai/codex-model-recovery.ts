import type { CodexSessionConfig } from "./codex";

// Deliberately narrow: quota, authentication and generic execution errors are
// not evidence that a model switch is safe or useful.
export function unavailableChatGptCodexModel(
  error: string,
): string | undefined {
  return /The ['"]([a-zA-Z0-9._-]+)['"] model is not supported when using Codex with a ChatGPT account\./i.exec(
    error,
  )?.[1];
}

export function codexModelRecoveryConfig(
  config: CodexSessionConfig | undefined,
  model: string,
): CodexSessionConfig {
  return {
    ...config,
    model,
    reasoning: undefined,
    serviceTier: "standard",
    // A rejected ChatGPT request must never fall back to a paid API key.
    paymentSource: "subscription",
  };
}
