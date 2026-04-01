import type { CodexThreadConfig } from "@cocalc/chat";
import {
  normalizeCodexSessionId,
  resolveCodexSessionMode,
  type CodexSessionConfig,
} from "@cocalc/util/ai/codex";

type ConfigLike =
  | CodexThreadConfig
  | {
      get?: (key: string) => unknown;
      [key: string]: unknown;
    };

function field<T = unknown>(
  record: ConfigLike | null | undefined,
  key: string,
): T | undefined {
  if (record == null) return undefined;
  const getter = (record as { get?: (name: string) => unknown }).get;
  if (typeof getter === "function") {
    return getter(key) as T;
  }
  return record[key] as T;
}

function resolveWorkingDirectory(chatPath: string): string {
  if (!chatPath) return ".";
  const i = chatPath.lastIndexOf("/");
  if (i <= 0) return ".";
  return chatPath.slice(0, i);
}

function resolveEnv(
  config: ConfigLike | null | undefined,
): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  const existingEnv = field<Record<string, unknown>>(config, "env");
  if (existingEnv && typeof existingEnv === "object") {
    for (const [key, value] of Object.entries(existingEnv)) {
      if (typeof value === "string" && value.length > 0) {
        env[key] = value;
      }
    }
  }
  const envHome = `${field<string>(config, "envHome") ?? ""}`.trim();
  if (envHome) {
    env.HOME = envHome;
  }
  const envPath = `${field<string>(config, "envPath") ?? ""}`.trim();
  if (envPath) {
    env.PATH = envPath;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

export function buildAutomationAcpConfig({
  chatPath,
  config,
}: {
  chatPath: string;
  config?: ConfigLike | null;
}): CodexSessionConfig {
  const workingDirectory =
    `${field<string>(config, "workingDirectory") ?? ""}`.trim() ||
    resolveWorkingDirectory(chatPath);
  const sessionMode = resolveCodexSessionMode(config as CodexSessionConfig);
  const next: CodexSessionConfig = {
    workingDirectory,
    sessionMode,
    allowWrite: sessionMode !== "read-only",
  };
  const model = `${field<string>(config, "model") ?? ""}`.trim();
  if (model) {
    next.model = model;
  }
  const reasoning = field<CodexSessionConfig["reasoning"]>(config, "reasoning");
  if (
    reasoning === "low" ||
    reasoning === "medium" ||
    reasoning === "high" ||
    reasoning === "extra_high"
  ) {
    next.reasoning = reasoning;
  }
  const env = resolveEnv(config);
  if (env) {
    next.env = env;
  }
  const codexPathOverride =
    `${field<string>(config, "codexPathOverride") ?? ""}`.trim();
  if (codexPathOverride) {
    next.codexPathOverride = codexPathOverride;
  }
  const sessionId = normalizeCodexSessionId(field<string>(config, "sessionId"));
  if (sessionId) {
    next.sessionId = sessionId;
  }
  return next;
}
