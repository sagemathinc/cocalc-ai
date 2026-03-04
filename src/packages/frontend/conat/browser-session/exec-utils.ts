import type {
  BrowserActionName,
  BrowserAutomationPosture,
  BrowserExecPolicyV1,
} from "@cocalc/conat/service/browser-session";
import {
  asFinitePositive,
  asOptionalFiniteNumber,
  requireAbsolutePath,
} from "./common-utils";

export const BROWSER_EXEC_POLICY_VERSION = 1;

export type BrowserNotifyType =
  | "error"
  | "default"
  | "success"
  | "info"
  | "warning";

export type BrowserExecMode = "raw_js" | "quickjs_wasm";

export type BrowserBashOptions = {
  cwd?: string;
  path?: string;
  timeout?: number;
  max_output?: number;
  err_on_exit?: boolean;
  env?: Record<string, string>;
  filesystem?: boolean;
};

export type BrowserTerminalSpawnOptions = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  env0?: Record<string, string>;
  rows?: number;
  cols?: number;
  timeout?: number;
  handleFlowControl?: boolean;
};

export type BrowserTerminalHistoryOptions = {
  max_chars?: number;
};

export function normalizePosture(value: unknown): BrowserAutomationPosture {
  const v = `${value ?? ""}`.trim().toLowerCase();
  return v === "prod" ? "prod" : "dev";
}

export function normalizePolicy(
  policy: unknown,
): BrowserExecPolicyV1 | undefined {
  if (!policy || typeof policy !== "object") {
    return undefined;
  }
  const row = policy as Record<string, unknown>;
  const version = Number(row.version ?? BROWSER_EXEC_POLICY_VERSION);
  if (version !== BROWSER_EXEC_POLICY_VERSION) {
    throw Error(
      `unsupported browser exec policy version '${row.version ?? ""}' (expected ${BROWSER_EXEC_POLICY_VERSION})`,
    );
  }
  const toOptionalStringArray = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const out = value
      .map((x) => `${x ?? ""}`.trim())
      .filter((x) => x.length > 0);
    return out.length > 0 ? out : undefined;
  };
  const allow_raw_exec =
    row.allow_raw_exec == null ? undefined : !!row.allow_raw_exec;
  const allowed_project_ids = toOptionalStringArray(row.allowed_project_ids);
  const allowed_origins = toOptionalStringArray(row.allowed_origins);
  const allowed_actions = toOptionalStringArray(row.allowed_actions)?.filter(
    (x): x is BrowserActionName => isAllowedActionName(x),
  );
  return {
    version: BROWSER_EXEC_POLICY_VERSION,
    ...(allow_raw_exec != null ? { allow_raw_exec } : {}),
    ...(allowed_project_ids ? { allowed_project_ids } : {}),
    ...(allowed_origins ? { allowed_origins } : {}),
    ...(allowed_actions?.length ? { allowed_actions } : {}),
  };
}

export function isAllowedActionName(value: unknown): value is BrowserActionName {
  const clean = `${value ?? ""}`.trim();
  return (
    clean === "click" ||
    clean === "click_at" ||
    clean === "drag" ||
    clean === "type" ||
    clean === "press" ||
    clean === "reload" ||
    clean === "navigate" ||
    clean === "scroll_by" ||
    clean === "scroll_to" ||
    clean === "wait_for_selector" ||
    clean === "wait_for_url" ||
    clean === "batch"
  );
}

export function enforcePolicyScope({
  project_id,
  posture,
  policy,
}: {
  project_id: string;
  posture?: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
}): {
  posture: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
} {
  const normalizedPosture = normalizePosture(posture);
  const normalizedPolicy = normalizePolicy(policy);

  const allowedProjects = normalizedPolicy?.allowed_project_ids ?? [];
  if (allowedProjects.length > 0 && !allowedProjects.includes(project_id)) {
    throw Error(
      `browser exec denied by policy: project '${project_id}' not in allowed_project_ids`,
    );
  }

  const allowedOrigins = normalizedPolicy?.allowed_origins ?? [];
  if (allowedOrigins.length > 0) {
    const currentOrigin =
      typeof location !== "undefined" ? `${location.origin ?? ""}`.trim() : "";
    if (!currentOrigin || !allowedOrigins.includes(currentOrigin)) {
      throw Error(
        `browser exec denied by policy: origin '${currentOrigin || "<unknown>"}' not in allowed_origins`,
      );
    }
  }

  return {
    posture: normalizedPosture,
    ...(normalizedPolicy ? { policy: normalizedPolicy } : {}),
  };
}

export function enforceExecPolicy({
  project_id,
  posture,
  policy,
}: {
  project_id: string;
  posture?: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
}): {
  posture: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
} {
  return enforcePolicyScope({ project_id, posture, policy });
}

export function resolveExecMode({
  project_id,
  posture,
  policy,
}: {
  project_id: string;
  posture?: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
}): {
  posture: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
  mode: BrowserExecMode;
} {
  const scoped = enforceExecPolicy({ project_id, posture, policy });
  const mode: BrowserExecMode =
    scoped.posture === "prod" && !scoped.policy?.allow_raw_exec
      ? "quickjs_wasm"
      : "raw_js";
  return { ...scoped, mode };
}

export function enforceActionPolicy({
  project_id,
  action_name,
  posture,
  policy,
}: {
  project_id: string;
  action_name: BrowserActionName;
  posture?: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
}): {
  posture: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
} {
  const scoped = enforcePolicyScope({ project_id, posture, policy });
  if (scoped.posture !== "prod") {
    return scoped;
  }
  const allowed = scoped.policy?.allowed_actions ?? [];
  if (allowed.length > 0 && !allowed.includes(action_name)) {
    throw Error(
      `browser action denied by policy: action '${action_name}' not in allowed_actions`,
    );
  }
  return scoped;
}

export function sanitizeBashOptions(opts: unknown): BrowserBashOptions {
  if (opts == null || typeof opts !== "object") {
    return {};
  }
  const row = opts as {
    cwd?: unknown;
    path?: unknown;
    timeout?: unknown;
    max_output?: unknown;
    err_on_exit?: unknown;
    env?: unknown;
    filesystem?: unknown;
  };
  const cwd = row.cwd == null ? undefined : requireAbsolutePath(row.cwd, "cwd");
  const path =
    row.path == null ? undefined : requireAbsolutePath(row.path, "path");
  const timeout = asFinitePositive(row.timeout);
  const max_output = asFinitePositive(row.max_output);
  const env =
    row.env != null && typeof row.env === "object"
      ? (row.env as Record<string, string>)
      : undefined;
  const err_on_exit = row.err_on_exit == null ? undefined : !!row.err_on_exit;
  const filesystem = row.filesystem == null ? undefined : !!row.filesystem;
  return {
    ...(cwd != null ? { cwd } : {}),
    ...(path != null ? { path } : {}),
    ...(timeout != null ? { timeout } : {}),
    ...(max_output != null ? { max_output } : {}),
    ...(err_on_exit != null ? { err_on_exit } : {}),
    ...(env != null ? { env } : {}),
    ...(filesystem != null ? { filesystem } : {}),
  };
}

export function sanitizeTerminalSpawnOptions(
  options: unknown,
): BrowserTerminalSpawnOptions {
  if (options == null || typeof options !== "object") {
    return {};
  }
  const row = options as {
    command?: unknown;
    args?: unknown;
    cwd?: unknown;
    env?: unknown;
    env0?: unknown;
    rows?: unknown;
    cols?: unknown;
    timeout?: unknown;
    handleFlowControl?: unknown;
  };
  const command =
    row.command == null ? undefined : `${row.command ?? ""}`.trim() || undefined;
  const args = Array.isArray(row.args)
    ? row.args.map((x) => `${x ?? ""}`)
    : undefined;
  const cwd = row.cwd == null ? undefined : requireAbsolutePath(row.cwd, "cwd");
  const env =
    row.env != null && typeof row.env === "object"
      ? (row.env as Record<string, string>)
      : undefined;
  const env0 =
    row.env0 != null && typeof row.env0 === "object"
      ? (row.env0 as Record<string, string>)
      : undefined;
  const rows = asFinitePositive(row.rows);
  const cols = asFinitePositive(row.cols);
  const timeout = asFinitePositive(row.timeout);
  const handleFlowControl =
    row.handleFlowControl == null ? undefined : !!row.handleFlowControl;
  return {
    ...(command ? { command } : {}),
    ...(args != null ? { args } : {}),
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
    ...(env0 ? { env0 } : {}),
    ...(rows != null ? { rows: Math.max(2, Math.floor(rows)) } : {}),
    ...(cols != null ? { cols: Math.max(2, Math.floor(cols)) } : {}),
    ...(timeout != null ? { timeout } : {}),
    ...(handleFlowControl != null ? { handleFlowControl } : {}),
  };
}

export function sanitizeTerminalHistoryOptions(
  options: unknown,
): BrowserTerminalHistoryOptions {
  if (options == null || typeof options !== "object") {
    return {};
  }
  const row = options as { max_chars?: unknown };
  const max_chars = asFinitePositive(row.max_chars);
  return {
    ...(max_chars != null ? { max_chars: Math.floor(max_chars) } : {}),
  };
}

export function sanitizeNotifyOptions(
  opts: unknown,
): {
  type?: BrowserNotifyType;
  title?: string;
  timeout?: number;
  block?: boolean;
} {
  if (opts == null || typeof opts !== "object") {
    return {};
  }
  const row = opts as {
    type?: unknown;
    title?: unknown;
    timeout?: unknown;
    block?: unknown;
  };
  const maybeType = `${row.type ?? ""}`.trim() as BrowserNotifyType;
  const type: BrowserNotifyType | undefined =
    maybeType === "error" ||
    maybeType === "default" ||
    maybeType === "success" ||
    maybeType === "info" ||
    maybeType === "warning"
      ? maybeType
      : undefined;
  const title = row.title == null ? undefined : `${row.title}`.trim() || undefined;
  const timeout = asOptionalFiniteNumber(row.timeout);
  const block = row.block == null ? undefined : !!row.block;
  return {
    ...(type ? { type } : {}),
    ...(title ? { title } : {}),
    ...(timeout != null ? { timeout } : {}),
    ...(block != null ? { block } : {}),
  };
}

export function asPlain(value: any): any {
  if (value != null && typeof value.toJS === "function") {
    return value.toJS();
  }
  return value;
}

function trunc(value: string, max = 4000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function simplifyNotebookOutputMessage(message: any): Record<string, unknown> {
  const obj = asPlain(message) ?? {};
  const data = asPlain(obj.data) ?? {};
  const plainText = (() => {
    if (typeof obj.text === "string" && obj.text.length > 0) return obj.text;
    const textPlain = data["text/plain"];
    if (typeof textPlain === "string" && textPlain.length > 0) return textPlain;
    if (Array.isArray(textPlain) && textPlain.length > 0) {
      return textPlain.join("");
    }
    if (Array.isArray(obj.traceback) && obj.traceback.length > 0) {
      return obj.traceback.join("\n");
    }
    return undefined;
  })();

  const out: Record<string, unknown> = {};
  if (obj.output_type != null) out.output_type = obj.output_type;
  if (obj.msg_type != null) out.msg_type = obj.msg_type;
  if (obj.name != null) out.name = obj.name;
  if (obj.execution_count != null) out.execution_count = obj.execution_count;
  if (obj.ename != null) out.ename = obj.ename;
  if (obj.evalue != null) out.evalue = obj.evalue;
  if (plainText != null) out.text = trunc(`${plainText}`);
  if (data != null && typeof data === "object") {
    const dataTypes = Object.keys(data);
    if (dataTypes.length > 0) out.data_types = dataTypes;
  }
  if (obj.metadata != null) out.metadata = asPlain(obj.metadata);
  return out;
}

export function simplifyNotebookOutput(output: any): unknown {
  const obj = asPlain(output);
  if (obj == null) return null;
  if (typeof obj !== "object") {
    return { count: 1, messages: [{ text: trunc(`${obj}`) }] };
  }
  const entries = Object.entries(obj);
  const messages = entries
    .sort((a, b) => Number.parseInt(a[0], 10) - Number.parseInt(b[0], 10))
    .map(([, value]) => simplifyNotebookOutputMessage(value));
  return { count: messages.length, messages };
}

export function sanitizeCellIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((x) => `${x ?? ""}`.trim())
    .filter((x) => x.length > 0);
}

export function sanitizeCellUpdates(
  value: unknown,
): {
  id: string;
  input: string;
}[] {
  if (!Array.isArray(value)) return [];
  const updates: { id: string; input: string }[] = [];
  for (const item of value) {
    const row = item as { id?: unknown; input?: unknown };
    const id = `${row?.id ?? ""}`.trim();
    if (!id) {
      continue;
    }
    const input = `${row?.input ?? ""}`;
    updates.push({ id, input });
  }
  return updates;
}

export function createExecId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  const uuid = g?.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `exec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
