/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { matchWildcard, type WildcardToken } from "./linear-text";

export const PROJECT_USER_ROLES = ["owner", "collaborator", "viewer"] as const;

export type ProjectUserRole = (typeof PROJECT_USER_ROLES)[number];
export type ProjectAccessRole = ProjectUserRole | "admin" | "none";
export type ProjectViewerReadRuleAction = "include" | "exclude";

export interface ProjectViewerReadRule {
  action: ProjectViewerReadRuleAction;
  path: string;
}

export interface ProjectViewerReadPolicy {
  rules: ProjectViewerReadRule[];
}

export interface ProjectUserInfo {
  group?: string | null;
  read_policy?: ProjectViewerReadPolicy | null;
  hide?: boolean | null;
  ssh_keys?: Record<string, unknown> | null;
}

export interface ProjectAccessCapabilities {
  readProjectMetadata: boolean;
  readProjectFiles: boolean;
  writeProjectFiles: boolean;
  useProjectRuntime: boolean;
  useTerminal: boolean;
  useSsh: boolean;
  useProjectSecrets: boolean;
  manageCollaborators: boolean;
  manageProjectSettings: boolean;
  manageSnapshotsBackups: boolean;
}

export interface ProjectAccess {
  role: ProjectAccessRole;
  read_policy?: ProjectViewerReadPolicy;
  capabilities: ProjectAccessCapabilities;
}

export const DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY: ProjectViewerReadPolicy =
  {
    rules: [
      { action: "include", path: "." },
      { action: "exclude", path: ".snapshots" },
      { action: "exclude", path: ".snapshots/**" },
      { action: "exclude", path: ".ssh" },
      { action: "exclude", path: ".ssh/**" },
      { action: "exclude", path: ".local/share/cocalc" },
      { action: "exclude", path: ".local/share/cocalc/**" },
    ],
  };

const NO_CAPABILITIES: ProjectAccessCapabilities = {
  readProjectMetadata: false,
  readProjectFiles: false,
  writeProjectFiles: false,
  useProjectRuntime: false,
  useTerminal: false,
  useSsh: false,
  useProjectSecrets: false,
  manageCollaborators: false,
  manageProjectSettings: false,
  manageSnapshotsBackups: false,
};

const VIEWER_CAPABILITIES: ProjectAccessCapabilities = {
  ...NO_CAPABILITIES,
  readProjectMetadata: true,
  readProjectFiles: true,
};

const COLLABORATOR_CAPABILITIES: ProjectAccessCapabilities = {
  readProjectMetadata: true,
  readProjectFiles: true,
  writeProjectFiles: true,
  useProjectRuntime: true,
  useTerminal: true,
  useSsh: true,
  useProjectSecrets: true,
  manageCollaborators: true,
  manageProjectSettings: true,
  manageSnapshotsBackups: true,
};

const OWNER_CAPABILITIES: ProjectAccessCapabilities = {
  ...COLLABORATOR_CAPABILITIES,
};

export function normalizeProjectUserRole(
  value: unknown,
): ProjectUserRole | undefined {
  const role = `${value ?? ""}`.trim();
  return (PROJECT_USER_ROLES as readonly string[]).includes(role)
    ? (role as ProjectUserRole)
    : undefined;
}

export function isProjectUserRole(value: unknown): value is ProjectUserRole {
  return normalizeProjectUserRole(value) != null;
}

export function isProjectCollaboratorRole(
  value: unknown,
): value is "owner" | "collaborator" {
  return value === "owner" || value === "collaborator";
}

export function isProjectViewerRole(value: unknown): value is "viewer" {
  return value === "viewer";
}

export function projectAccessFromRole({
  role,
  read_policy,
}: {
  role?: ProjectAccessRole;
  read_policy?: ProjectViewerReadPolicy | null;
}): ProjectAccess {
  switch (role) {
    case "admin":
      return { role: "admin", capabilities: { ...OWNER_CAPABILITIES } };
    case "owner":
      return { role: "owner", capabilities: { ...OWNER_CAPABILITIES } };
    case "collaborator":
      return {
        role: "collaborator",
        capabilities: { ...COLLABORATOR_CAPABILITIES },
      };
    case "viewer":
      return {
        role: "viewer",
        read_policy: read_policy ?? undefined,
        capabilities: { ...VIEWER_CAPABILITIES },
      };
    default:
      return { role: "none", capabilities: { ...NO_CAPABILITIES } };
  }
}

export function projectAccessFromUsers({
  account_id,
  users,
  admin = false,
}: {
  account_id: string;
  users?: Record<string, ProjectUserInfo | undefined | null> | null;
  admin?: boolean;
}): ProjectAccess {
  if (admin) {
    return projectAccessFromRole({ role: "admin" });
  }
  const info = users?.[account_id];
  const role = normalizeProjectUserRole(info?.group);
  return projectAccessFromRole({
    role,
    read_policy: role === "viewer" ? info?.read_policy : undefined,
  });
}

export function normalizeProjectViewerPolicyPath(
  path: string,
): string | undefined {
  const raw = `${path ?? ""}`.replace(/\\/g, "/");
  if (raw === "" || raw === "." || raw === "/") {
    return "";
  }
  const withoutLeadingSlash = raw.startsWith("/") ? raw.slice(1) : raw;
  const parts: string[] = [];
  for (const part of withoutLeadingSlash.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length === 0) {
        return undefined;
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

// Rule globs: "**" matches any run of characters, "*" any run within one
// path segment, and everything else itself. Match them with an explicit
// automaton: as a backtracking regular expression each "*" multiplied the
// cost, so a rule with a few dozen stars stalled the host.
//
// That expression compiled "**" to ".*", which stops at line terminators
// (legal in paths). An include keeps exactly that, so no rule grants more
// than it did. An exclude's "**" also crosses them, which only denies more:
// "**/.env" now excludes "a\nb/.env" too.
function globTokens(
  pattern: string,
  action: "include" | "exclude",
): WildcardToken[] {
  const tokens: WildcardToken[] = [];
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      const crossSlash = pattern[i + 1] === "*";
      if (crossSlash) {
        i += 1;
      }
      tokens.push(
        crossSlash && action === "include"
          ? { kind: "run", crossSlash, lineTerminators: false }
          : { kind: "run", crossSlash },
      );
    } else {
      tokens.push({ kind: "literal", char });
    }
  }
  return tokens;
}

// PATH_MAX on Linux. Longer paths cannot name a file, and longer rules are
// not real paths; both bound the matching work. Checks fail closed: an
// oversized path is never readable, and an oversized exclude rule denies.
const MAX_VIEWER_POLICY_PATH_LENGTH = 4096;

function oversizedRulePath(rule: ProjectViewerReadRule): boolean {
  return `${rule.path ?? ""}`.length > MAX_VIEWER_POLICY_PATH_LENGTH;
}

function viewerReadRuleMatches({
  rulePath,
  path,
  action,
}: {
  rulePath: string;
  path: string;
  action: "include" | "exclude";
}): boolean {
  const normalizedRulePath = normalizeProjectViewerPolicyPath(rulePath);
  if (normalizedRulePath == null) {
    return false;
  }
  if (normalizedRulePath === "") {
    return true;
  }
  if (path === normalizedRulePath) {
    return true;
  }
  if (normalizedRulePath.endsWith("/**")) {
    const directory = normalizedRulePath.slice(0, -3);
    return path === directory || path.startsWith(`${directory}/`);
  }
  return matchWildcard(globTokens(normalizedRulePath, action), path);
}

export function viewerReadPolicyAllowsPath({
  policy,
  path,
}: {
  policy?: ProjectViewerReadPolicy | null;
  path: string;
}): boolean {
  const normalizedPath = normalizeProjectViewerPolicyPath(path);
  if (
    normalizedPath == null ||
    normalizedPath.length > MAX_VIEWER_POLICY_PATH_LENGTH ||
    !Array.isArray(policy?.rules)
  ) {
    return false;
  }
  let included = false;
  for (const rule of policy.rules) {
    if (rule?.action !== "include" && rule?.action !== "exclude") {
      continue;
    }
    if (oversizedRulePath(rule)) {
      if (rule.action === "exclude") {
        return false;
      }
      continue;
    }
    if (
      !viewerReadRuleMatches({
        rulePath: rule.path,
        path: normalizedPath,
        action: rule.action,
      })
    ) {
      continue;
    }
    if (rule.action === "exclude") {
      return false;
    }
    included = true;
  }
  return included;
}

function firstGlobIndex(path: string): number {
  const indexes = ["*", "?", "["]
    .map((char) => path.indexOf(char))
    .filter((index) => index >= 0);
  return indexes.length ? Math.min(...indexes) : -1;
}

function viewerIncludeRuleMayMatchDescendant({
  rulePath,
  path,
}: {
  rulePath: string;
  path: string;
}): boolean {
  const normalizedRulePath = normalizeProjectViewerPolicyPath(rulePath);
  if (normalizedRulePath == null) {
    return false;
  }
  if (normalizedRulePath === "") {
    return true;
  }
  if (path === "") {
    return true;
  }
  if (
    normalizedRulePath === path ||
    normalizedRulePath.startsWith(`${path}/`)
  ) {
    return true;
  }
  const globIndex = firstGlobIndex(normalizedRulePath);
  if (globIndex < 0) {
    return false;
  }
  const literalPrefix = normalizedRulePath.slice(0, globIndex);
  const slash = literalPrefix.lastIndexOf("/");
  const literalBase = slash >= 0 ? literalPrefix.slice(0, slash) : "";
  return literalBase === path || literalBase.startsWith(`${path}/`);
}

export function viewerReadPolicyMayAllowDescendant({
  policy,
  path,
}: {
  policy?: ProjectViewerReadPolicy | null;
  path: string;
}): boolean {
  const normalizedPath = normalizeProjectViewerPolicyPath(path);
  if (
    normalizedPath == null ||
    normalizedPath.length > MAX_VIEWER_POLICY_PATH_LENGTH ||
    !Array.isArray(policy?.rules)
  ) {
    return false;
  }
  for (const rule of policy.rules) {
    if (rule?.action !== "exclude") {
      continue;
    }
    if (oversizedRulePath(rule)) {
      return false;
    }
    if (
      viewerReadRuleMatches({
        rulePath: rule.path,
        path: normalizedPath,
        action: "exclude",
      })
    ) {
      return false;
    }
  }
  return policy.rules.some(
    (rule) =>
      rule?.action === "include" &&
      !oversizedRulePath(rule) &&
      viewerIncludeRuleMayMatchDescendant({
        rulePath: rule.path,
        path: normalizedPath,
      }),
  );
}
