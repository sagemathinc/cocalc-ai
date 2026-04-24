export interface CodexReasoningLevel {
  id: "low" | "medium" | "high" | "extra_high";
  label: string;
  description: string;
  default?: boolean;
}

export interface CodexModelInfo {
  name: string;
  description?: string;
  reasoning?: CodexReasoningLevel[];
}

export type CodexReasoningId = CodexReasoningLevel["id"];

export type CodexSessionMode =
  | "auto"
  | "read-only"
  | "workspace-write"
  | "full-access";

export interface CodexSessionConfig {
  workingDirectory?: string;
  sessionId?: string;
  model?: string;
  reasoning?: CodexReasoningId;
  allowWrite?: boolean;
  sessionMode?: CodexSessionMode;
  env?: Record<string, string>;
  codexPathOverride?: string;
}

export function normalizeCodexSessionId(
  sessionId?: string | null,
): string | undefined {
  const trimmed = `${sessionId ?? ""}`.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveCodexSessionMode(
  config?: CodexSessionConfig,
): CodexSessionMode {
  const mode = config?.sessionMode;
  if (
    mode === "auto" ||
    mode === "read-only" ||
    mode === "workspace-write" ||
    mode === "full-access"
  ) {
    return mode;
  }
  if (typeof config?.allowWrite === "boolean") {
    return config.allowWrite ? "auto" : "read-only";
  }
  return "auto";
}

export const DEFAULT_CODEX_MODEL_NAME = "gpt-5.4";

const DEFAULT_REASONING_LEVELS: CodexReasoningLevel[] = [
  {
    id: "low",
    label: "Low",
    description: "Fast responses with lighter reasoning.",
  },
  {
    id: "medium",
    label: "Medium",
    description: "Balances speed and reasoning depth for everyday tasks.",
    default: true,
  },
  {
    id: "high",
    label: "High",
    description: "Greater reasoning depth for complex problems.",
  },
  {
    id: "extra_high",
    label: "Extra high",
    description: "Extra high reasoning depth for complex problems.",
  },
];

const SPARK_REASONING_LEVELS: CodexReasoningLevel[] = [
  {
    id: "low",
    label: "Low",
    description: "Fast responses with lighter reasoning.",
  },
  {
    id: "medium",
    label: "Medium",
    description: "Balances speed and reasoning depth for everyday tasks.",
  },
  {
    id: "high",
    label: "High",
    description: "Greater reasoning depth for complex problems.",
    default: true,
  },
  {
    id: "extra_high",
    label: "Extra high",
    description: "Extra high reasoning depth for complex problems.",
  },
];

const GPT_5_2_REASONING_LEVELS: CodexReasoningLevel[] = [
  {
    id: "low",
    label: "Low",
    description:
      "Balances speed with some reasoning; useful for straightforward queries and short explanations.",
  },
  {
    id: "medium",
    label: "Medium",
    description:
      "Provides a solid balance of reasoning depth and latency for general-purpose tasks.",
    default: true,
  },
  {
    id: "high",
    label: "High",
    description: "Maximizes reasoning depth for complex or ambiguous problems.",
  },
  {
    id: "extra_high",
    label: "Extra high",
    description: "Extra high reasoning depth for complex problems.",
  },
];

export const DEFAULT_CODEX_MODELS: CodexModelInfo[] = [
  {
    name: DEFAULT_CODEX_MODEL_NAME,
    description: "Strong model for everyday coding.",
    reasoning: DEFAULT_REASONING_LEVELS,
  },
  {
    name: "gpt-5.5",
    description:
      "Frontier model for complex coding, research, and real-world work.",
    reasoning: DEFAULT_REASONING_LEVELS,
  },
  {
    name: "gpt-5.4-mini",
    description:
      "Small, fast, and cost-efficient model for simpler coding tasks.",
    reasoning: DEFAULT_REASONING_LEVELS,
  },
  {
    name: "gpt-5.3-codex",
    description: "Coding-optimized model.",
    reasoning: DEFAULT_REASONING_LEVELS,
  },
  {
    name: "gpt-5.3-codex-spark",
    description: "Ultra-fast coding model.",
    reasoning: SPARK_REASONING_LEVELS,
  },
  {
    name: "gpt-5.2",
    description: "Optimized for professional work and long-running agents.",
    reasoning: GPT_5_2_REASONING_LEVELS,
  },
];

const CODEX_MODEL_NAME_SET = new Set(
  DEFAULT_CODEX_MODELS.map((model) => model.name.toLowerCase()),
);

const CODEX_MODEL_ALIASES = new Set(["codex-agent", "openai-codex-agent"]);

export function isCodexModelName(model?: string): boolean {
  if (typeof model !== "string") return false;
  const normalized = model.trim().toLowerCase();
  if (!normalized) return false;
  if (CODEX_MODEL_ALIASES.has(normalized)) return true;
  if (CODEX_MODEL_NAME_SET.has(normalized)) return true;
  // Backward-compatible fallback for custom codex-style slugs.
  return normalized.includes("codex");
}
