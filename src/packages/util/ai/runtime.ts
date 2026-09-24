import type { CodexSessionConfig } from "./codex";
import { parseHarnessSessionSettings } from "./harness-controls";
import type { HarnessSessionSettings } from "./harness-controls";
import { getQualifiedHarnessCandidate } from "./qualified-harnesses";
import { isValidUUID } from "../misc";

/** Project-managed configuration only. Never store credential values here. */
export interface CustomAcpHarnessProfile {
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

/** Catalog identity only. Launch details are resolved from trusted code. */
export interface QualifiedAcpHarnessProfile {
  version: 2;
  kind: "acp";
  id: string;
  revision: string;
  cwd: string;
  executionPolicy: "full-access";
  credentialMode: "project-managed";
}

export type AcpHarnessProfile =
  | CustomAcpHarnessProfile
  | QualifiedAcpHarnessProfile;

export type AgentRuntimeConfig =
  | { version: 1; kind: "codex-native"; codex: CodexSessionConfig }
  | {
      version: 1;
      kind: "acp";
      profile: AcpHarnessProfile;
      settings?: HarnessSessionSettings;
    };

export type AcpHarnessRuntime = Extract<AgentRuntimeConfig, { kind: "acp" }>;

/** Request-local credential choice. Never persist this in shared chat config. */
export type AcpHarnessCredential =
  | {
      version: 1;
      provider: "project";
      mode: "project-managed";
    }
  | {
      version: 1;
      provider: "anthropic";
      mode: "project-secret";
    }
  | {
      version: 1;
      provider: "anthropic";
      mode: "account-api-key";
      credentialId: string;
    }
  | {
      version: 1;
      provider: "anthropic";
      mode: "account-subscription";
      credentialId: string;
    };

export function parseAcpHarnessCredential(
  value: unknown,
  profile: AcpHarnessProfile,
): AcpHarnessCredential {
  if (profile.version !== 2 || profile.id !== "claude-code") {
    if (value === undefined)
      return { version: 1, provider: "project", mode: "project-managed" };
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("This ACP harness does not support account credentials");
    const project = value as Record<string, unknown>;
    if (
      project.version !== 1 ||
      project.provider !== "project" ||
      project.mode !== "project-managed" ||
      Object.keys(project).some(
        (key) => !["version", "provider", "mode"].includes(key),
      )
    )
      throw Error("This ACP harness does not support account credentials");
    return { version: 1, provider: "project", mode: "project-managed" };
  }
  if (value === undefined) {
    return { version: 1, provider: "anthropic", mode: "project-secret" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Error("Invalid ACP harness credential selection");
  }
  const obj = value as Record<string, unknown>;
  if (
    obj.version !== 1 ||
    obj.provider !== "anthropic" ||
    (obj.mode !== "project-secret" &&
      obj.mode !== "account-api-key" &&
      obj.mode !== "account-subscription")
  ) {
    throw Error("Unsupported ACP harness credential selection");
  }
  if (obj.mode === "project-secret") {
    if (
      Object.keys(obj).some(
        (key) => !["version", "provider", "mode"].includes(key),
      )
    ) {
      throw Error("Unsupported ACP harness credential field");
    }
    return { version: 1, provider: "anthropic", mode: "project-secret" };
  }
  if (
    Object.keys(obj).some(
      (key) => !["version", "provider", "mode", "credentialId"].includes(key),
    ) ||
    typeof obj.credentialId !== "string" ||
    !isValidUUID(obj.credentialId)
  ) {
    throw Error("Invalid Anthropic account credential selection");
  }
  return {
    version: 1,
    provider: "anthropic",
    mode: obj.mode,
    credentialId: obj.credentialId,
  };
}

export function parseAcpHarnessRuntime(value: unknown): AcpHarnessRuntime {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Unsupported agent runtime");
  const obj = value as Record<string, unknown>;
  if (
    obj.version !== 1 ||
    obj.kind !== "acp" ||
    Object.keys(obj).some(
      (key) => !["version", "kind", "profile", "settings"].includes(key),
    )
  )
    throw Error("Unsupported agent runtime");
  return {
    version: 1,
    kind: "acp",
    profile: parseAcpHarnessProfile(obj.profile),
    ...(obj.settings === undefined
      ? {}
      : { settings: parseHarnessSessionSettings(obj.settings) }),
  };
}

/** Fail closed instead of interpreting an unknown runtime as native Codex. */
export function parseAcpHarnessProfile(value: unknown): AcpHarnessProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Error("ACP profile must be an object");
  }
  const obj = value as Record<string, unknown>;
  const commonKeys = [
    "version",
    "kind",
    "id",
    "revision",
    "cwd",
    "executionPolicy",
    "credentialMode",
  ];
  const keys = new Set(
    obj.version === 2 ? commonKeys : [...commonKeys, "executable", "args"],
  );
  if (Object.keys(obj).some((key) => !keys.has(key))) {
    throw Error("Unsupported ACP profile field");
  }
  if (
    (obj.version !== 1 && obj.version !== 2) ||
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
  const cwd = text("cwd", 4096);
  if (!cwd.startsWith("/")) {
    throw Error("ACP working directory must be an absolute container path");
  }
  const id = text("id", 128);
  const revision = text("revision", 128);
  if (obj.version === 2) {
    const candidate = getQualifiedHarnessCandidate(id);
    if (
      !candidate ||
      candidate.status === "disabled" ||
      revision !== candidate.package.version
    ) {
      throw Error("Unsupported qualified ACP harness or revision");
    }
    return {
      version: 2,
      kind: "acp",
      id,
      revision,
      cwd,
      executionPolicy: "full-access",
      credentialMode: "project-managed",
    };
  }
  const executable = text("executable", 4096);
  if (!executable.startsWith("/")) {
    throw Error("ACP executable must be an absolute container path");
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
    id,
    revision,
    executable,
    args: [...obj.args],
    cwd,
    executionPolicy: "full-access",
    credentialMode: "project-managed",
  };
}
