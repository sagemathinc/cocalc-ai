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
const MAX_CHECKS = 100;
const MAX_REVIEWS = 100;

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

// Trim the files list until the snapshot fits the size cap.
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
    } else if (snapshot.checks.length > 0 || snapshot.reviews.length > 0) {
      snapshot.checks = snapshot.checks.slice(0, 10);
      snapshot.reviews = snapshot.reviews.slice(0, 10);
      if (size() > MAX_MERGE_APPROVAL_SNAPSHOT_BYTES) {
        snapshot.checks = [];
        snapshot.reviews = [];
      }
    } else {
      throw new MergeApprovalGitHubError("pull request snapshot is too large");
    }
  }
  return snapshot;
}

// What GitHub says about the pull request now.
export async function readPullRequestSnapshot({
  config,
  repo,
  pr_number,
}: {
  config: MergeApprovalAppConfig;
  repo: string;
  pr_number: number;
}): Promise<MergeApprovalGitHubSnapshot> {
  const token = await installationToken(config, repo, READ_PERMISSIONS);
  const pr = await github("GET", `/repos/${repo}/pulls/${pr_number}`, token);
  const head_sha = str(pr?.head?.sha, 40).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head_sha)) {
    throw new MergeApprovalGitHubError("GitHub returned no head commit");
  }

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
    if (batch.length < FILES_PER_PAGE) break;
  }
  const changed_files = num(pr?.changed_files);

  const runs = await github(
    "GET",
    `/repos/${repo}/commits/${head_sha}/check-runs?per_page=${MAX_CHECKS}`,
    token,
  );
  const statuses = await github(
    "GET",
    `/repos/${repo}/commits/${head_sha}/status?per_page=${MAX_CHECKS}`,
    token,
  );
  const checks: MergeApprovalGitHubSnapshot["checks"] = [
    ...(Array.isArray(runs?.check_runs) ? runs.check_runs : []).map((r) => ({
      name: str(r?.name, 200),
      status: str(r?.status, 40),
      conclusion: r?.conclusion == null ? null : str(r.conclusion, 40),
    })),
    ...(Array.isArray(statuses?.statuses) ? statuses.statuses : []).map(
      (s) => ({
        name: str(s?.context, 200),
        status: s?.state === "pending" ? "pending" : "completed",
        conclusion: s?.state === "pending" ? null : str(s?.state, 40),
      }),
    ),
  ];

  const reviewList = await github(
    "GET",
    `/repos/${repo}/pulls/${pr_number}/reviews?per_page=${MAX_REVIEWS}`,
    token,
  );
  const reviews: MergeApprovalGitHubSnapshot["reviews"] = (
    Array.isArray(reviewList) ? reviewList : []
  ).map((r) => ({
    author: str(r?.user?.login, 100),
    state: str(r?.state, 40),
    commit_id: r?.commit_id == null ? null : str(r.commit_id, 40),
  }));

  return fitSnapshot({
    title: str(pr?.title, 500),
    state: pr?.merged ? "merged" : str(pr?.state, 20),
    draft: pr?.draft === true,
    author: str(pr?.user?.login, 100),
    base_ref: str(pr?.base?.ref, 255),
    head_ref: str(pr?.head?.ref, 255),
    head_sha,
    html_url: str(pr?.html_url, 500),
    additions: num(pr?.additions),
    deletions: num(pr?.deletions),
    changed_files,
    files,
    files_truncated: files.length < changed_files,
    checks,
    reviews,
    read_at: new Date().toISOString(),
  });
}
