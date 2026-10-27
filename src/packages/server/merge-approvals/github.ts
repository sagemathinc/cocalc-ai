/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

/*
GitHub access for merge approvals, as the merge-approval GitHub App (separate
from the GitHub connector App). Requests read the pull request through it, so
the card shows what GitHub says, not what the requesting agent says.

Installation tokens are narrowed to one repository and to the permissions the
call needs.
*/

import { createPrivateKey, createSign } from "node:crypto";
import {
  MAX_MERGE_APPROVAL_SNAPSHOT_BYTES,
  type MergeApprovalGitHubSnapshot,
} from "@cocalc/util/merge-approval";
import type { MergeApprovalAppConfig } from "./settings";

const GITHUB_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_FILES = 300;
const FILES_PER_PAGE = 100;
const PER_PAGE = 100;
// Checks and reviews are read in full up to this many pages each.
const MAX_LIST_PAGES = 10;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: Fetch = (url, init) => fetch(url, init);

// Tests replace GitHub; pass nothing to restore the real one.
export function setMergeApprovalGitHubFetchForTests(f?: Fetch): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init));
  tokenCache.clear();
}

export class MergeApprovalGitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}

// The App's own JWT, used only to mint installation tokens.
export function mergeApprovalAppJwt(
  config: Pick<MergeApprovalAppConfig, "app_id" | "private_key">,
  now_ms = Date.now(),
): string {
  const now = Math.floor(now_ms / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    // Backdated a minute for clock skew; GitHub allows at most 10 minutes.
    JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: config.app_id }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const key = createPrivateKey(config.private_key);
  return `${header}.${payload}.${base64url(signer.sign(key))}`;
}

function headers(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "cocalc-merge-approvals",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function github(
  method: "GET" | "POST",
  path: string,
  token: string,
  body?: unknown,
): Promise<any> {
  let resp: Response;
  try {
    resp = await fetchImpl(`${GITHUB_API}${path}`, {
      method,
      headers: {
        ...headers(token),
        ...(body == null ? {} : { "Content-Type": "application/json" }),
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new MergeApprovalGitHubError(`GitHub request failed: ${err}`);
  }
  if (!resp.ok) {
    // GitHub's message only: never echo the request (it carries the token).
    let message = "";
    try {
      message = `${((await resp.json()) as any)?.message ?? ""}`.slice(0, 200);
    } catch {
      // not JSON
    }
    throw new MergeApprovalGitHubError(
      `GitHub ${method} ${path.split("?")[0]} returned ${resp.status}${message ? `: ${message}` : ""}`,
      resp.status,
    );
  }
  return await resp.json();
}

type Permissions = Record<string, "read" | "write">;

const READ_PERMISSIONS: Permissions = {
  metadata: "read",
  pull_requests: "read",
  checks: "read",
  statuses: "read",
};

const tokenCache = new Map<string, { token: string; expires_at: number }>();

async function installationToken(
  config: MergeApprovalAppConfig,
  repo: string,
  permissions: Permissions,
): Promise<string> {
  const [owner, name] = repo.split("/");
  const installation_id = config.installations.get(owner);
  if (!installation_id) {
    throw new MergeApprovalGitHubError(
      `the merge approval App has no installation for ${owner}`,
    );
  }
  const key = `${config.app_id}:${installation_id}:${repo}:${JSON.stringify(permissions)}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expires_at - Date.now() > 5 * 60_000) {
    return cached.token;
  }
  const resp = await github(
    "POST",
    `/app/installations/${installation_id}/access_tokens`,
    mergeApprovalAppJwt(config),
    { repositories: [name], permissions },
  );
  const token = `${resp?.token ?? ""}`;
  const expires_at = Date.parse(`${resp?.expires_at ?? ""}`);
  if (!token || !Number.isFinite(expires_at)) {
    throw new MergeApprovalGitHubError("GitHub returned no installation token");
  }
  tokenCache.set(key, { token, expires_at });
  return token;
}

function str(value: unknown, max = 300): string {
  return `${value ?? ""}`.slice(0, max);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const FAILING_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale",
  "error",
]);

// Trim the lists until the snapshot fits the size cap, saying so: the
// summaries still count everything GitHub returned.
function fitSnapshot(
  snapshot: MergeApprovalGitHubSnapshot,
): MergeApprovalGitHubSnapshot {
  const size = () => Buffer.byteLength(JSON.stringify(snapshot));
  while (size() > MAX_MERGE_APPROVAL_SNAPSHOT_BYTES) {
    if (snapshot.files.length > 0) {
      snapshot.files = snapshot.files.slice(
        0,
        Math.floor(snapshot.files.length / 2),
      );
      snapshot.files_truncated = true;
    } else if (snapshot.checks.length > 10 || snapshot.reviews.length > 10) {
      // Keep failing checks and change requests first.
      snapshot.checks_truncated ||= snapshot.checks.length > 10;
      snapshot.reviews_truncated ||= snapshot.reviews.length > 10;
      snapshot.checks = [...snapshot.checks]
        .sort((a, b) => checkRank(a) - checkRank(b))
        .slice(0, 10);
      snapshot.reviews = [...snapshot.reviews]
        .sort((a, b) => reviewRank(a) - reviewRank(b))
        .slice(0, 10);
    } else if (snapshot.checks.length > 0 || snapshot.reviews.length > 0) {
      snapshot.checks_truncated ||= snapshot.checks.length > 0;
      snapshot.reviews_truncated ||= snapshot.reviews.length > 0;
      snapshot.checks = [];
      snapshot.reviews = [];
    } else {
      throw new MergeApprovalGitHubError("pull request snapshot is too large");
    }
  }
  return snapshot;
}

function checkRank(c: { conclusion: string | null; status: string }): number {
  if (c.conclusion != null && FAILING_CONCLUSIONS.has(c.conclusion)) return 0;
  return c.status === "completed" ? 2 : 1;
}

function reviewRank(r: { state: string }): number {
  return r.state === "CHANGES_REQUESTED" ? 0 : r.state === "APPROVED" ? 1 : 2;
}

interface PullRequestTarget {
  config: MergeApprovalAppConfig;
  repo: string;
  pr_number: number;
}

function commitSha(value: unknown, what: string): string {
  const sha = str(value, 40).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new MergeApprovalGitHubError(`GitHub returned no ${what} commit`);
  }
  return sha;
}

export interface PullRequestHead {
  head_sha: string;
  base_sha: string;
  base_ref: string;
  state: string;
  draft: boolean;
}

function pullRequestHead(pr: any): PullRequestHead {
  return {
    head_sha: commitSha(pr?.head?.sha, "head"),
    base_sha: commitSha(pr?.base?.sha, "base"),
    base_ref: str(pr?.base?.ref, 255),
    state: pr?.merged ? "merged" : str(pr?.state, 20),
    draft: pr?.draft === true,
  };
}

// Where the pull request is now: one request, for checks that must be fresh.
export async function readPullRequestHead({
  config,
  repo,
  pr_number,
}: PullRequestTarget): Promise<PullRequestHead> {
  const token = await installationToken(config, repo, READ_PERMISSIONS);
  return pullRequestHead(
    await github("GET", `/repos/${repo}/pulls/${pr_number}`, token),
  );
}

// What GitHub says about the pull request now. The files list follows the
// PR's current head, and the App can't read commits by SHA (no Contents
// permission). So the head and base are read again after every page of
// files and at the end, and the snapshot is read again if they moved at any
// point, or if the files don't fit the PR's totals (a complete list must add
// up to them; a shortened one may not exceed them). The card also links to
// GitHub's compare view of the exact base and head SHAs.
export async function readPullRequestSnapshot(
  target: PullRequestTarget,
): Promise<MergeApprovalGitHubSnapshot> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { snapshot, base_sha, consistent } = await readSnapshotOnce(target);
    const after = await readPullRequestHead(target);
    if (
      consistent &&
      after.head_sha === snapshot.head_sha &&
      after.base_sha === base_sha
    ) {
      return fitSnapshot(snapshot);
    }
  }
  throw Object.assign(
    new MergeApprovalGitHubError(
      "the pull request changed while it was being read; try again",
    ),
    { code: "head_changed" },
  );
}

async function readSnapshotOnce({
  config,
  repo,
  pr_number,
}: PullRequestTarget): Promise<{
  snapshot: MergeApprovalGitHubSnapshot;
  base_sha: string;
  consistent: boolean;
}> {
  const token = await installationToken(config, repo, READ_PERMISSIONS);
  const pr = await github("GET", `/repos/${repo}/pulls/${pr_number}`, token);
  const { head_sha, base_sha } = pullRequestHead(pr);

  const samePr = async () => {
    const now = pullRequestHead(
      await github("GET", `/repos/${repo}/pulls/${pr_number}`, token),
    );
    return now.head_sha === head_sha && now.base_sha === base_sha;
  };
  let unmoved = true;
  const files: MergeApprovalGitHubSnapshot["files"] = [];
  for (let page = 1; files.length < MAX_FILES; page++) {
    const batch = await github(
      "GET",
      `/repos/${repo}/pulls/${pr_number}/files?per_page=${FILES_PER_PAGE}&page=${page}`,
      token,
    );
    if (!Array.isArray(batch)) break;
    for (const f of batch) {
      files.push({
        filename: str(f?.filename, 1000),
        additions: num(f?.additions),
        deletions: num(f?.deletions),
      });
    }
    if (!(await samePr())) {
      unmoved = false;
      break;
    }
    if (batch.length < FILES_PER_PAGE) break;
  }
  const changed_files = num(pr?.changed_files);

  // Every page (up to MAX_LIST_PAGES), so the summaries count them all.
  const allPages = async (
    path: string,
    rows: (body: any) => any[],
  ): Promise<{ rows: any[]; total: number; more: boolean }> => {
    const all: any[] = [];
    let total = 0;
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const body = await github(
        "GET",
        `${path}${sep}per_page=${PER_PAGE}&page=${page}`,
        token,
      );
      const batch = rows(body);
      all.push(...batch);
      total = Math.max(total, num(body?.total_count));
      if (batch.length < PER_PAGE) {
        return { rows: all, total: Math.max(total, all.length), more: false };
      }
      if (total > 0 && all.length >= total) break;
    }
    const more = total > all.length || (total === 0 && all.length > 0);
    return { rows: all, total: Math.max(total, all.length), more };
  };
  const runs = await allPages(
    `/repos/${repo}/commits/${head_sha}/check-runs`,
    (body) => (Array.isArray(body?.check_runs) ? body.check_runs : []),
  );
  const statuses = await allPages(
    `/repos/${repo}/commits/${head_sha}/status`,
    (body) => (Array.isArray(body?.statuses) ? body.statuses : []),
  );
  const runList = runs.rows;
  const statusList = statuses.rows;
  const checks: MergeApprovalGitHubSnapshot["checks"] = [
    ...runList.map((r) => ({
      name: str(r?.name, 200),
      status: str(r?.status, 40),
      conclusion: r?.conclusion == null ? null : str(r.conclusion, 40),
    })),
    ...statusList.map((s) => ({
      name: str(s?.context, 200),
      status: s?.state === "pending" ? "pending" : "completed",
      conclusion: s?.state === "pending" ? null : str(s?.state, 40),
    })),
  ];

  const reviewPages = await allPages(
    `/repos/${repo}/pulls/${pr_number}/reviews`,
    (body) => (Array.isArray(body) ? body : []),
  );
  const reviewRows = reviewPages.rows;
  const reviews: MergeApprovalGitHubSnapshot["reviews"] = reviewRows.map(
    (r) => ({
      author: str(r?.user?.login, 100),
      state: str(r?.state, 40),
      commit_id: r?.commit_id == null ? null : str(r.commit_id, 40),
    }),
  );

  const additions = num(pr?.additions);
  const deletions = num(pr?.deletions);
  const complete = files.length === changed_files;
  const fileAdditions = files.reduce((n, f) => n + f.additions, 0);
  const fileDeletions = files.reduce((n, f) => n + f.deletions, 0);
  const consistent =
    unmoved &&
    files.length <= changed_files &&
    (complete
      ? fileAdditions === additions && fileDeletions === deletions
      : fileAdditions <= additions && fileDeletions <= deletions);
  const snapshot: MergeApprovalGitHubSnapshot = {
    title: str(pr?.title, 500),
    state: pr?.merged ? "merged" : str(pr?.state, 20),
    draft: pr?.draft === true,
    author: str(pr?.user?.login, 100),
    base_ref: str(pr?.base?.ref, 255),
    head_ref: str(pr?.head?.ref, 255),
    head_sha,
    base_sha,
    html_url: str(pr?.html_url, 500),
    additions,
    deletions,
    changed_files,
    files,
    files_truncated: files.length < changed_files,
    checks,
    check_summary: {
      total: runs.total + statuses.total,
      // failing and pending are counted over this many (all of them, unless
      // there were more than MAX_LIST_PAGES pages).
      counted: checks.length,
      failing: checks.filter((c) => checkRank(c) === 0).length,
      pending: checks.filter((c) => checkRank(c) === 1).length,
    },
    checks_truncated: runs.more || statuses.more,
    reviews,
    review_summary: {
      total: reviews.length,
      changes_requested: reviews.filter((r) => r.state === "CHANGES_REQUESTED")
        .length,
      approved: reviews.filter((r) => r.state === "APPROVED").length,
      complete: !reviewPages.more,
    },
    reviews_truncated: reviewPages.more,
    read_at: new Date().toISOString(),
  };
  return { snapshot, base_sha, consistent };
}
