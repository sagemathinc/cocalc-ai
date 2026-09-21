import type { CodexSessionConfig } from "./codex";

/** Project-managed configuration only. Never store credential values here. */
export interface AcpHarnessProfile {
  version: 1;
  kind: "acp";
  id: string;
  revision: string;
  executable: string;
  args: string[];
  cwd: string;
  executionPolicy: "full-access";
  credentialMode: "project-managed";
}

export type AgentRuntimeConfig =
  | { version: 1; kind: "codex-native"; codex: CodexSessionConfig }
  | { version: 1; kind: "acp"; profile: AcpHarnessProfile };

export type AcpHarnessRuntime = Extract<AgentRuntimeConfig, { kind: "acp" }>;

export function parseAcpHarnessRuntime(value: unknown): AcpHarnessRuntime {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Unsupported agent runtime");
  const obj = value as Record<string, unknown>;
  if (
    obj.version !== 1 ||
    obj.kind !== "acp" ||
    Object.keys(obj).some(
      (key) => !["version", "kind", "profile"].includes(key),
    )
  )
    throw Error("Unsupported agent runtime");
  return {
    version: 1,
    kind: "acp",
    profile: parseAcpHarnessProfile(obj.profile),
  };
}

/** Fail closed instead of interpreting an unknown runtime as native Codex. */
export function parseAcpHarnessProfile(value: unknown): AcpHarnessProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Error("ACP profile must be an object");
  }
  const obj = value as Record<string, unknown>;
  const keys = new Set([
    "version",
    "kind",
    "id",
    "revision",
    "executable",
    "args",
    "cwd",
    "executionPolicy",
    "credentialMode",
  ]);
  if (Object.keys(obj).some((key) => !keys.has(key))) {
    throw Error("Unsupported ACP profile field");
  }
  if (
    obj.version !== 1 ||
    obj.kind !== "acp" ||
    obj.executionPolicy !== "full-access" ||
    obj.credentialMode !== "project-managed"
  ) {
    throw Error("Unsupported ACP profile version or policy");
  }
  const text = (key: string, max: number): string => {
    const v = obj[key];
    if (
      typeof v !== "string" ||
      !v.trim() ||
      v.length > max ||
      /[\x00-\x1f]/.test(v)
    ) {
      throw Error(`Invalid ACP profile ${key}`);
    }
    return v;
  };
  const executable = text("executable", 4096);
  const cwd = text("cwd", 4096);
  if (!executable.startsWith("/") || !cwd.startsWith("/")) {
    throw Error(
      "ACP executable and working directory must be absolute container paths",
    );
  }
  if (
    !Array.isArray(obj.args) ||
    obj.args.length > 128 ||
    obj.args.some(
      (arg) =>
        typeof arg !== "string" || arg.length > 8192 || arg.includes("\0"),
    ) ||
    JSON.stringify(obj.args).length > 32768
  ) {
    throw Error("Invalid ACP arguments");
  }
  return {
    version: 1,
    kind: "acp",
    id: text("id", 128),
    revision: text("revision", 128),
    executable,
    args: [...obj.args],
    cwd,
    executionPolicy: "full-access",
    credentialMode: "project-managed",
  };
}
