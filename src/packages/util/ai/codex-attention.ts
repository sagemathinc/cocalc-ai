/** Shared limit for each free-form answer to a Codex question. */
export const CODEX_ATTENTION_ANSWER_MAX_LENGTH = 32_000;

/** Agent runtimes that ask questions. Reasons they report are prefixed with these. */
export const CODEX_ATTENTION_RUNTIME_LABELS = [
  "Codex",
  "ACP",
  "Claude",
  "Agent",
] as const;

export type CodexAttentionRuntimeLabel =
  (typeof CODEX_ATTENTION_RUNTIME_LABELS)[number];

export function codexAttentionAcceptedReason(
  runtime: CodexAttentionRuntimeLabel,
): string {
  return `${runtime} accepted the response`;
}

/** The runtime whose explicit acceptance of an answer this reason records. */
export function codexAttentionAcceptingRuntime(
  reason: string | undefined,
): CodexAttentionRuntimeLabel | undefined {
  return CODEX_ATTENTION_RUNTIME_LABELS.find(
    (runtime) => reason === codexAttentionAcceptedReason(runtime),
  );
}

/** How user-facing text names a runtime ("ACP" is not a name for an agent). */
export function codexAttentionRuntimeName(
  runtime: CodexAttentionRuntimeLabel,
): string {
  return runtime === "Codex" || runtime === "Claude" ? runtime : "The agent";
}
