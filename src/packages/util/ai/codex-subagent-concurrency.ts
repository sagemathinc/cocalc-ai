export const OTHER_SETTINGS_CODEX_MAX_CONCURRENT_SUBAGENTS =
  "codex_max_concurrent_subagents";
export const MIN_CODEX_CONCURRENT_SUBAGENTS = 1;
export const MAX_CODEX_CONCURRENT_SUBAGENTS = 16;

export function normalizeCodexMaxConcurrentSubagents(
  value: unknown,
): number | undefined {
  if (value == null || value === "" || value === "automatic") return;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return;
  return Math.min(
    MAX_CODEX_CONCURRENT_SUBAGENTS,
    Math.max(MIN_CODEX_CONCURRENT_SUBAGENTS, parsed),
  );
}
