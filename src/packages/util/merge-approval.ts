/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

/*
Merge approvals: a person approves the merge of one exact pull-request head in
CoCalc, and the hub records it where no agent or project credential can write.
An agent only requests; an approver decides from a browser session. See
server/merge-approvals.
*/

import { isValidUUID } from "./misc";

// A request is open for this long; after that it can no longer be decided.
export const MERGE_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Records are kept at least this long (audit lookback).
export const MERGE_APPROVAL_RETENTION = "13 months";

// Limits per requesting project, so a misbehaving agent can't flood the
// approvers.
export const MAX_PENDING_MERGE_APPROVALS_PER_PROJECT = 50;
export const MAX_NEW_MERGE_APPROVALS_PER_PROJECT_PER_HOUR = 30;
export const MAX_MERGE_APPROVAL_NOTE_BYTES = 8 * 1024;
export const MAX_MERGE_APPROVAL_COMMENT_BYTES = 2 * 1024;
// Cap on the stored GitHub snapshot (files list etc. are truncated to fit).
export const MAX_MERGE_APPROVAL_SNAPSHOT_BYTES = 64 * 1024;

export const MERGE_APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "superseded",
  "withdrawn",
  "expired",
] as const;
export type MergeApprovalStatus = (typeof MERGE_APPROVAL_STATUSES)[number];

export const MERGE_APPROVAL_DECISIONS = ["approve", "reject"] as const;
export type MergeApprovalDecisionKind =
  (typeof MERGE_APPROVAL_DECISIONS)[number];

// What the hub read from GitHub when the request was made. Shown on the card;
// nothing here comes from the requesting agent.
export interface MergeApprovalGitHubSnapshot {
  title: string;
  state: string;
  draft: boolean;
  author: string;
  base_ref: string;
  head_ref: string;
  head_sha: string;
  html_url: string;
  additions: number;
  deletions: number;
  changed_files: number;
  // At most a few hundred, by name; files_truncated says if there were more.
  files: { filename: string; additions: number; deletions: number }[];
  files_truncated: boolean;
  checks: { name: string; conclusion: string | null; status: string }[];
  reviews: { author: string; state: string; commit_id: string | null }[];
  read_at: string;
}

export interface MergeApprovalChatRef {
  project_id: string;
  path: string;
  thread_id?: string;
  message_date?: string;
}

// Who asked, as established by the hub from the authenticated session (never
// from arguments). agent_label is what the agent calls itself, for display.
export interface MergeApprovalRequester {
  account_id: string;
  project_id: string;
  token_fingerprint?: string;
  agent_label?: string;
}

export interface MergeApprovalRequest {
  id: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  base_ref: string;
  github_snapshot: MergeApprovalGitHubSnapshot;
  // Supplied by the agent; shown labelled as the agent's.
  agent_note: string;
  requested_by: MergeApprovalRequester;
  chat?: MergeApprovalChatRef;
  created_at: string;
  expires_at: string;
  status: MergeApprovalStatus;
}

export interface MergeApprovalDecision {
  id: string;
  request_id: string;
  account_id: string;
  decision: MergeApprovalDecisionKind;
  comment: string;
  session_hash: string;
  factor_level: string;
  decided_at: string;
}

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;

export function normalizeMergeApprovalRepo(value: unknown): string {
  const repo = `${value ?? ""}`.trim();
  if (!REPO.test(repo) || repo.endsWith("/.") || repo.endsWith("/..")) {
    throw new Error("repo must be owner/name");
  }
  return repo.toLowerCase();
}

export function normalizeMergeApprovalPrNumber(value: unknown): number {
  const n = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 1e9) {
    throw new Error("pr_number must be a positive integer");
  }
  return n;
}

// The full 40-character commit SHA: an abbreviation could match a different
// commit later.
export function normalizeMergeApprovalHeadSha(value: unknown): string {
  const sha = `${value ?? ""}`.trim().toLowerCase();
  if (!SHA.test(sha)) {
    throw new Error("head_sha must be the full 40-character commit SHA");
  }
  return sha;
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function normalizeMergeApprovalText(
  value: unknown,
  maxBytes: number,
  label: string,
): string {
  const text = `${value ?? ""}`;
  if (utf8Bytes(text) > maxBytes) {
    throw new Error(`${label} is longer than ${maxBytes} bytes`);
  }
  return text;
}

export function normalizeMergeApprovalChatRef(
  value: unknown,
  project_id: string,
): MergeApprovalChatRef | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object") throw new Error("invalid chat reference");
  const v = value as Record<string, unknown>;
  const path = `${v.path ?? ""}`.trim();
  if (!path || path.length > 4096) throw new Error("invalid chat path");
  // The card goes into the requesting project's own chat, not another one.
  if (v.project_id != null && v.project_id !== project_id) {
    throw new Error("chat reference must be in the requesting project");
  }
  const thread_id =
    v.thread_id == null ? undefined : `${v.thread_id}`.trim().slice(0, 200);
  const message_date =
    v.message_date == null
      ? undefined
      : `${v.message_date}`.trim().slice(0, 100);
  return { project_id, path, thread_id, message_date };
}

// Site settings: lists of account ids or repos, separated by commas or
// whitespace.
function splitList(value: unknown): string[] {
  return `${value ?? ""}`
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseMergeApprovers(value: unknown): string[] {
  return [...new Set(splitList(value).filter((id) => isValidUUID(id)))];
}

export function parseMergeApprovalRepos(value: unknown): string[] {
  const repos: string[] = [];
  for (const entry of splitList(value)) {
    try {
      repos.push(normalizeMergeApprovalRepo(entry));
    } catch {
      // ignore malformed entries
    }
  }
  return [...new Set(repos)];
}

// Repos where approving needs a second factor: "*" means all of them, and so
// does a blank setting (fail closed); "none" means none.
export function mergeApprovalNeedsSecondFactor(
  repo: string,
  setting: unknown,
): boolean {
  const entries = splitList(setting);
  if (entries.length === 0 || entries.includes("*")) return true;
  if (entries.length === 1 && entries[0].toLowerCase() === "none") {
    return false;
  }
  return parseMergeApprovalRepos(entries.join(",")).includes(repo);
}

// "owner:installation_id" entries, e.g. "sagemathinc:12345".
export function parseMergeApprovalInstallations(
  value: unknown,
): Map<string, string> {
  const installations = new Map<string, string>();
  for (const entry of splitList(value)) {
    const m = /^([A-Za-z0-9][A-Za-z0-9-]{0,38}):(\d{1,20})$/.exec(entry);
    if (m) installations.set(m[1].toLowerCase(), m[2]);
  }
  return installations;
}
