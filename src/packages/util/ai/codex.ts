export interface CodexReasoningLevel {
  id: "low" | "medium" | "high" | "extra_high" | "max" | "ultra";
  label: string;
  description: string;
  default?: boolean;
}

export interface CodexModelInfo {
  name: string;
  description?: string;
  reasoning?: CodexReasoningLevel[];
  serviceTiers?: CodexServiceTierInfo[];
}

export type CodexReasoningId = CodexReasoningLevel["id"];
export type CodexServiceTier = "standard" | "fast";

export type CodexPaymentSourcePreference =
  | "auto"
  | "subscription"
  | "project-api-key"
  | "account-api-key"
  | "site-api-key"
  | "shared-home";

export interface CodexServiceTierInfo {
  id: CodexServiceTier;
  label: string;
  description: string;
  default?: boolean;
}

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
  serviceTier?: CodexServiceTier;
  allowWrite?: boolean;
  sessionMode?: CodexSessionMode;
  env?: Record<string, string>;
  codexPathOverride?: string;
  paymentSource?: CodexPaymentSourcePreference;
  // Account-wide limit for spawned workers. The manager thread is not counted.
  maxConcurrentSubagents?: number;
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

export const DEFAULT_CODEX_MODEL_NAME = "gpt-5.6-sol";
export const CODEX_FAST_SERVICE_TIER_REQUEST_VALUE = "fast";
// These 0.151 features are disabled by default upstream. Keep every CoCalc
// app-server launch path on the same rollout format and maintenance policy.
export const CODEX_APP_SERVER_FEATURE_ARGS = [
  "--enable",
  "image_generation",
  "--enable",
  "background_paginated_rollout_migration",
  "--enable",
  "local_thread_store_compression",
] as const;

const GPT_5_6_SOL_REASONING_LEVELS: CodexReasoningLevel[] = [
  {
    id: "low",
    label: "Low",
    description: "Fast responses with lighter reasoning.",
    default: true,
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
  },
  {
    id: "extra_high",
    label: "Extra high",
    description: "Extra high reasoning depth for complex problems.",
  },
  {
    id: "max",
    label: "Max",
    description: "Maximum reasoning depth for the hardest problems.",
  },
  {
    id: "ultra",
    label: "Ultra",
    description: "Maximum reasoning with automatic task delegation.",
  },
];

const GPT_5_6_REASONING_LEVELS: CodexReasoningLevel[] = [
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
  {
    id: "max",
    label: "Max",
    description: "Maximum reasoning depth for the hardest problems.",
  },
  {
    id: "ultra",
    label: "Ultra",
    description: "Maximum reasoning with automatic task delegation.",
  },
];

const GPT_5_6_LUNA_REASONING_LEVELS: CodexReasoningLevel[] = [
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
  {
    id: "max",
    label: "Max",
    description: "Maximum reasoning depth for the hardest problems.",
  },
];

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

const FAST_SERVICE_TIER: CodexServiceTierInfo = {
  id: "fast",
  label: "Fast",
  description: "1.5x speed with higher Codex credit usage.",
};

export const DEFAULT_CODEX_MODELS: CodexModelInfo[] = [
  {
    name: DEFAULT_CODEX_MODEL_NAME,
    description: "Latest frontier agentic coding model.",
    reasoning: GPT_5_6_SOL_REASONING_LEVELS,
    serviceTiers: [FAST_SERVICE_TIER],
  },
  {
    name: "gpt-5.6-terra",
    description: "Balanced agentic coding model for everyday work.",
    reasoning: GPT_5_6_REASONING_LEVELS,
    serviceTiers: [FAST_SERVICE_TIER],
  },
  {
    name: "gpt-5.6-luna",
    description: "Fast and affordable agentic coding model.",
    reasoning: GPT_5_6_LUNA_REASONING_LEVELS,
    serviceTiers: [FAST_SERVICE_TIER],
  },
  {
    name: "gpt-5.5",
    description:
      "Frontier model for complex coding, research, and real-world work.",
    reasoning: DEFAULT_REASONING_LEVELS,
    serviceTiers: [FAST_SERVICE_TIER],
  },
  {
    name: "gpt-5.4",
    description: "Strong model for everyday coding.",
    reasoning: DEFAULT_REASONING_LEVELS,
    serviceTiers: [FAST_SERVICE_TIER],
  },
  {
    name: "gpt-5.4-mini",
    description:
      "Small, fast, and cost-efficient model for simpler coding tasks.",
    reasoning: DEFAULT_REASONING_LEVELS,
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

const CODEX_MODEL_ALIASES = new Set([
  "codex-agent",
  "gpt-5.6",
  "openai-codex-agent",
]);

const CODEX_MODEL_CANONICAL_ALIASES = new Map([["gpt-5.6", "gpt-5.6-sol"]]);

export function isCodexModelName(model?: string): boolean {
  if (typeof model !== "string") return false;
  const normalized = model.trim().toLowerCase();
  if (!normalized) return false;
  if (CODEX_MODEL_ALIASES.has(normalized)) return true;
  if (CODEX_MODEL_NAME_SET.has(normalized)) return true;
  // Backward-compatible fallback for custom codex-style slugs.
  return normalized.includes("codex");
}

export function normalizeCodexServiceTier(
  serviceTier?: string | null,
): CodexServiceTier {
  return serviceTier === "fast" ? "fast" : "standard";
}

export function codexModelSupportsFastMode(model?: string): boolean {
  const raw = `${model ?? ""}`.trim().toLowerCase();
  const normalized = CODEX_MODEL_CANONICAL_ALIASES.get(raw) ?? raw;
  return (
    DEFAULT_CODEX_MODELS.find(
      (entry) => entry.name === normalized,
    )?.serviceTiers?.some((tier) => tier.id === "fast") === true
  );
}

export function resolveCodexServiceTier(
  config?: Pick<CodexSessionConfig, "model" | "serviceTier"> | null,
): CodexServiceTier {
  const serviceTier = normalizeCodexServiceTier(config?.serviceTier);
  if (serviceTier !== "fast") return "standard";
  const rawModel = `${config?.model ?? ""}`.trim().toLowerCase();
  if (!rawModel) return "standard";
  const model = CODEX_MODEL_CANONICAL_ALIASES.get(rawModel) ?? rawModel;
  const knownModel = DEFAULT_CODEX_MODELS.find((entry) => entry.name === model);
  // Dynamic account catalogs can advertise models before this fallback list is
  // updated. Preserve an explicit Fast selection for those models; Codex is the
  // final authority and will reject a stale or unsupported capability.
  return knownModel == null || codexModelSupportsFastMode(model)
    ? "fast"
    : "standard";
}

export function codexServiceTierForAppServer(
  config?: Pick<CodexSessionConfig, "model" | "serviceTier"> | null,
): string | null {
  return resolveCodexServiceTier(config) === "fast"
    ? CODEX_FAST_SERVICE_TIER_REQUEST_VALUE
    : null;
}
