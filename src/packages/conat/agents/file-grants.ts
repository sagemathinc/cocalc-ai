/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { isValidUUID } from "@cocalc/util/misc";
import type { HostConnectionInfo } from "@cocalc/conat/hub/api/hosts";

export const AGENT_FILE_SERVICE = "fs-agent";
export const AGENT_FILE_GRANT_MODE = "read" as const;
export const MAX_AGENT_FILE_GRANT_ROOTS = 20;
export const MAX_AGENT_FILE_GRANTS = 50;

export interface AgentFileGrant {
  grant_id: string;
  account_id: string;
  agent_id: string;
  source_project_id: string;
  target_project_id: string;
  roots: string[];
  mode: typeof AGENT_FILE_GRANT_MODE;
  created_at: Date | string;
  updated_at: Date | string;
  revoked_at?: Date | string | null;
}

export interface AgentFileGrantSubject {
  account_id: string;
  target_project_id: string;
  source_project_id: string;
  grant_id: string;
  agent_id: string;
  run_id: string;
}

export interface PreparedAgentFileGrant {
  version: 1;
  grant: AgentFileGrant;
  subject: string;
  connection: HostConnectionInfo;
  token: string;
  expires_at: number;
}

function requireUuid(value: unknown, name: string): asserts value is string {
  if (!isValidUUID(value)) throw new Error(`${name} must be a UUID`);
}

export function normalizeAgentFileGrantRoot(value: unknown): string {
  if (typeof value !== "string") throw new Error("grant root must be a string");
  const raw = value.trim().replace(/\\/g, "/");
  if (!raw || raw === "." || raw === "/" || raw === "/home/user") return "";
  if (raw.startsWith("/") && !raw.startsWith("/home/user/")) {
    throw new Error("grant root must be inside the project home");
  }
  const relative = raw
    .replace(/^\/home\/user\/?/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const parts = relative.split("/");
  if (
    !relative ||
    parts.some((part) => !part || part === "." || part === "..") ||
    relative.length > 1024
  ) {
    throw new Error("grant root must be a path inside the project home");
  }
  return relative;
}

export function normalizeAgentFileGrantRoots(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw new Error("at least one file grant root is required");
  }
  if (value.length > MAX_AGENT_FILE_GRANT_ROOTS) {
    throw new Error(`at most ${MAX_AGENT_FILE_GRANT_ROOTS} roots are allowed`);
  }
  const roots = [...new Set(value.map(normalizeAgentFileGrantRoot))];
  if (roots.includes("")) return [""];
  return roots.filter(
    (root) =>
      !roots.some((other) => other !== root && root.startsWith(`${other}/`)),
  );
}

export function agentFileGrantSubject(value: AgentFileGrantSubject): string {
  requireUuid(value.account_id, "account_id");
  requireUuid(value.target_project_id, "target_project_id");
  requireUuid(value.source_project_id, "source_project_id");
  requireUuid(value.grant_id, "grant_id");
  requireUuid(value.agent_id, "agent_id");
  requireUuid(value.run_id, "run_id");
  return [
    AGENT_FILE_SERVICE,
    `account-${value.account_id}`,
    `target-${value.target_project_id}`,
    `source-${value.source_project_id}`,
    `grant-${value.grant_id}`,
    `agent-${value.agent_id}`,
    `run-${value.run_id}`,
  ].join(".");
}

export function agentFileGrantInboxPrefix(
  value: AgentFileGrantSubject,
): string {
  return `_INBOX.${agentFileGrantSubject(value)}`;
}

export function parseAgentFileGrantSubject(
  subject: string,
): AgentFileGrantSubject | undefined {
  const parts = subject.split(".");
  if (parts.length !== 7 || parts[0] !== AGENT_FILE_SERVICE) return;
  const result = {
    account_id: parts[1]?.replace(/^account-/, ""),
    target_project_id: parts[2]?.replace(/^target-/, ""),
    source_project_id: parts[3]?.replace(/^source-/, ""),
    grant_id: parts[4]?.replace(/^grant-/, ""),
    agent_id: parts[5]?.replace(/^agent-/, ""),
    run_id: parts[6]?.replace(/^run-/, ""),
  };
  if (Object.values(result).some((value) => !isValidUUID(value))) return;
  return result as AgentFileGrantSubject;
}

export function validatePreparedAgentFileGrant(
  value: PreparedAgentFileGrant,
): void {
  if (value?.version !== 1 || typeof value.token !== "string" || !value.token) {
    throw new Error("invalid prepared file grant");
  }
  const parsed = parseAgentFileGrantSubject(value.subject);
  if (
    !parsed ||
    parsed.account_id !== value.grant?.account_id ||
    parsed.agent_id !== value.grant?.agent_id ||
    parsed.source_project_id !== value.grant?.source_project_id ||
    parsed.grant_id !== value.grant?.grant_id ||
    parsed.target_project_id !== value.grant?.target_project_id ||
    !Number.isFinite(value.expires_at) ||
    value.expires_at <= Date.now()
  ) {
    throw new Error("prepared file grant is mismatched or expired");
  }
  normalizeAgentFileGrantRoots(value.grant.roots);
}
