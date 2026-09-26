/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type {
  ApiKeyCapability,
  ApiKeyProjectGrant,
  ApiKeyScope,
} from "./db-schema/api-keys";
import { API_KEY_CAPABILITIES } from "./db-schema/api-keys";
import { isValidUUID } from "./misc";
import {
  DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY,
  normalizeProjectViewerPolicyPath,
  type ProjectViewerReadPolicy,
} from "./project-access";

export const FULL_PROJECT_API_KEY_CAPABILITIES: readonly ApiKeyCapability[] = [
  "file:read",
  "file:write",
  "project:exec",
  "project:read",
  "project:write",
];

export const VIEWER_PROJECT_API_KEY_CAPABILITIES: readonly ApiKeyCapability[] =
  ["file:read"];

const ACCOUNT_CAPABILITIES = new Set<ApiKeyCapability>([
  "account:read",
  "api-key:revoke:request",
  "project:create",
  "project:list",
]);
const PROJECT_CAPABILITIES = new Set<ApiKeyCapability>([
  "project:read",
  "project:write",
  "file:read",
  "file:write",
  "project:exec",
  "codex:run",
]);
const ALL_CAPABILITIES = new Set<string>(API_KEY_CAPABILITIES);
const MAX_PROJECTS = 100;
const MAX_ROOTS = 32;
const MAX_SCOPE_BYTES = 64 * 1024;

function record(value: unknown, name: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw Error(`unknown ${name} field '${key}'`);
    }
  }
}

function capabilities(
  input: unknown,
  allowed: Set<ApiKeyCapability>,
  name: string,
): ApiKeyCapability[] {
  if (!Array.isArray(input)) {
    throw Error(`${name} capabilities must be an array`);
  }
  const result = new Set<ApiKeyCapability>();
  for (const value of input) {
    if (typeof value !== "string" || !ALL_CAPABILITIES.has(value)) {
      throw Error(`invalid ${name} capability`);
    }
    if (!allowed.has(value as ApiKeyCapability)) {
      throw Error(`capability '${value}' is not valid for ${name}`);
    }
    result.add(value as ApiKeyCapability);
  }
  return [...result].sort();
}

function roots(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_ROOTS) {
    throw Error(`viewer read roots must contain 1 to ${MAX_ROOTS} paths`);
  }
  const result = new Set<string>();
  for (const raw of input) {
    if (
      typeof raw !== "string" ||
      raw.length > 1024 ||
      raw.startsWith("/") ||
      raw.includes("\\") ||
      /[*?\[\]]/.test(raw)
    ) {
      throw Error("viewer read roots must be literal project-relative paths");
    }
    const normalized = normalizeProjectViewerPolicyPath(raw);
    if (
      normalized == null ||
      (raw !== "." && normalized !== raw) ||
      raw === "" ||
      raw === ".ssh" ||
      raw.startsWith(".ssh/") ||
      raw === ".snapshots" ||
      raw.startsWith(".snapshots/") ||
      raw === ".local/share/cocalc" ||
      raw.startsWith(".local/share/cocalc/")
    ) {
      throw Error("invalid viewer read root");
    }
    result.add(raw);
  }
  if (result.has(".") && result.size !== 1) {
    throw Error("whole-project viewer access cannot have additional roots");
  }
  return [...result].sort();
}

function projectPermissions(
  grant: Record<string, unknown>,
): Omit<ApiKeyProjectGrant, "project_id"> {
  const allowed = capabilities(
    grant.capabilities,
    PROJECT_CAPABILITIES,
    "project",
  );
  if (allowed.length === 0)
    throw Error("project grant must contain a capability");
  const hasBroadRuntime =
    allowed.includes("project:exec") || allowed.includes("file:write");
  const needsViewerPolicy = allowed.includes("file:read") && !hasBroadRuntime;
  if (needsViewerPolicy !== (grant.viewer_read_roots != null)) {
    throw Error(
      "read-only file grants require viewer roots; broader grants cannot claim viewer roots",
    );
  }
  return {
    capabilities: allowed,
    ...(needsViewerPolicy
      ? { viewer_read_roots: roots(grant.viewer_read_roots) }
      : {}),
  };
}

export function normalizeApiKeyScopeV1(
  input: unknown,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): ApiKeyScope {
  const value = record(input, "scope");
  exactKeys(value, ["version", "account", "projects", "all_projects"], "scope");
  if (value.version !== 1 || !Array.isArray(value.projects)) {
    throw Error("unsupported API key scope version or projects");
  }
  if (value.projects.length > MAX_PROJECTS) {
    throw Error(`API key scope exceeds ${MAX_PROJECTS} projects`);
  }
  const account = capabilities(value.account, ACCOUNT_CAPABILITIES, "account");
  const seen = new Set<string>();
  const projects = value.projects.map((raw) => {
    const grant = record(raw, "project grant");
    exactKeys(
      grant,
      ["project_id", "capabilities", "viewer_read_roots"],
      "project grant",
    );
    const project_id = grant.project_id;
    if (typeof project_id !== "string" || !isValidUUID(project_id)) {
      throw Error("invalid API key project id");
    }
    if (seen.has(project_id)) {
      throw Error("duplicate API key project grant");
    }
    seen.add(project_id);
    return {
      project_id,
      ...projectPermissions(grant),
    };
  });
  let all_projects: ApiKeyScope["all_projects"];
  if (value.all_projects != null) {
    const grant = record(value.all_projects, "all-projects grant");
    exactKeys(
      grant,
      ["capabilities", "viewer_read_roots"],
      "all-projects grant",
    );
    all_projects = projectPermissions(grant);
  }
  if (
    !allowEmpty &&
    account.length === 0 &&
    projects.length === 0 &&
    !all_projects
  ) {
    throw Error("API key scope must grant at least one capability");
  }
  projects.sort((a, b) => a.project_id.localeCompare(b.project_id));
  const scope: ApiKeyScope = {
    version: 1,
    account,
    projects,
    ...(all_projects ? { all_projects } : {}),
  };
  if (
    new TextEncoder().encode(JSON.stringify(scope)).byteLength > MAX_SCOPE_BYTES
  ) {
    throw Error("API key scope exceeds 64 KiB");
  }
  return scope;
}

export function legacyApiKeyScope({
  capabilities: input,
  allowed_project_ids,
}: {
  capabilities: ApiKeyCapability[];
  allowed_project_ids: string[];
}): ApiKeyScope {
  const account = input.filter((value) => ACCOUNT_CAPABILITIES.has(value));
  const projectCapabilities = input.filter((value) =>
    PROJECT_CAPABILITIES.has(value),
  );
  return normalizeApiKeyScopeV1({
    version: 1,
    account,
    projects:
      projectCapabilities.length === 0
        ? []
        : allowed_project_ids.map((project_id) => ({
            project_id,
            capabilities: projectCapabilities,
            ...(projectCapabilities.includes("file:read") &&
            !projectCapabilities.includes("project:exec") &&
            !projectCapabilities.includes("file:write")
              ? { viewer_read_roots: ["."] }
              : {}),
          })),
  });
}

export function apiKeyScopeAllows(
  scope: ApiKeyScope,
  capability: ApiKeyCapability,
  project_id?: string,
): boolean {
  if (project_id == null) {
    return scope.account.includes(capability);
  }
  return (
    apiKeyProjectGrant(scope, project_id)?.capabilities.includes(capability) ??
    false
  );
}

// An explicit project grant overrides the default, including a narrower grant.
// Membership is checked by the authoritative service, not by this scope lookup.
export function apiKeyProjectGrant(
  scope: ApiKeyScope,
  project_id: string,
): ApiKeyProjectGrant | undefined {
  return (
    scope.projects.find((grant) => grant.project_id === project_id) ??
    (scope.all_projects ? { ...scope.all_projects, project_id } : undefined)
  );
}

export function viewerPolicyForApiKeyGrant(
  scope: ApiKeyScope,
  project_id: string,
): ProjectViewerReadPolicy | undefined {
  const grant = apiKeyProjectGrant(scope, project_id);
  if (!grant?.viewer_read_roots) return;
  return {
    rules: [
      ...grant.viewer_read_roots.flatMap((path) =>
        path === "."
          ? [{ action: "include" as const, path: "." }]
          : [
              { action: "include" as const, path },
              { action: "include" as const, path: `${path}/**` },
            ],
      ),
      ...DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY.rules.filter(
        (rule) => rule.action === "exclude",
      ),
    ],
  };
}
