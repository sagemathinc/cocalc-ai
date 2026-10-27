/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { createVerify, generateKeyPairSync } from "node:crypto";
import { MAX_MERGE_APPROVAL_SNAPSHOT_BYTES } from "@cocalc/util/merge-approval";
import {
  gitHubBudget,
  mergeApprovalAppJwt,
  readPullRequestHead,
  readPullRequestSnapshot,
  setMergeApprovalGitHubFetchForTests,
} from "./github";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const config = {
  app_id: "4242",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  installations: new Map([["sagemathinc", "99"]]),
};
const HEAD = "c".repeat(40);
const BASE = "b".repeat(40);
const INSTALLATION_TOKEN = "ghs_installation_token_for_tests";

type Call = { method: string; url: string; headers: any; body?: any };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// A small fake GitHub: routes by path, records every call.
function fakeGitHub({
  pr = {},
  files = [{ filename: "a.ts", additions: 1, deletions: 2 }],
  overrides = {},
  checkRuns,
  reviews,
}: {
  pr?: Record<string, unknown> | (() => Record<string, unknown>);
  files?: any[];
  overrides?: Record<string, () => Response>;
  checkRuns?: any[];
  reviews?: any[];
} = {}) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const path = url.replace("https://api.github.com", "");
    calls.push({
      method: init?.method ?? "GET",
      url: path,
      headers: init?.headers,
      body: init?.body ? JSON.parse(`${init.body}`) : undefined,
    });
    const base = path.split("?")[0];
    if (overrides[base]) return overrides[base]();
    if (base === "/app/installations/99/access_tokens") {
      return json({
        token: INSTALLATION_TOKEN,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    }
    if (base === "/repos/sagemathinc/cocalc-ai/pulls/12") {
      return json({
        title: "Fix it",
        state: "open",
        draft: false,
        merged: false,
        user: { login: "agent" },
        base: { ref: "main", sha: BASE },
        head: { ref: "fix", sha: HEAD },
        html_url: "https://github.com/sagemathinc/cocalc-ai/pull/12",
        additions: files.reduce((n, f) => n + f.additions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
        changed_files: files.length,
        ...(typeof pr === "function" ? pr() : pr),
      });
    }
    if (base === "/repos/sagemathinc/cocalc-ai/pulls/12/files") {
      const page = Number(new URL(url).searchParams.get("page"));
      return json(files.slice((page - 1) * 100, page * 100));
    }
    if (
      /^\/repos\/sagemathinc\/cocalc-ai\/commits\/[0-9a-f]{40}\/check-runs$/.test(
        base,
      )
    ) {
      const all = checkRuns ?? [
        { name: "test", status: "completed", conclusion: "success" },
      ];
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      return json({
        total_count: all.length,
        check_runs: all.slice((page - 1) * 100, page * 100),
      });
    }
    if (
      /^\/repos\/sagemathinc\/cocalc-ai\/commits\/[0-9a-f]{40}\/status$/.test(
        base,
      )
    ) {
      return json({ statuses: [{ context: "ci/legacy", state: "pending" }] });
    }
    if (base === "/repos/sagemathinc/cocalc-ai/pulls/12/reviews") {
      const all = reviews ?? [
        { user: { login: "codex" }, state: "COMMENTED", commit_id: HEAD },
      ];
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      return json(all.slice((page - 1) * 100, page * 100));
    }
    return json({ message: "Not Found" }, 404);
  };
  return { calls, fetchImpl };
}

afterEach(() => setMergeApprovalGitHubFetchForTests());

const budget = () => gitHubBudget({ max_calls: 1000, timeout_ms: 60_000 });

describe("merge approval GitHub App", () => {
  it("signs a short-lived RS256 App JWT", () => {
    const now = Date.parse("2026-10-27T00:00:00Z");
    const jwt = mergeApprovalAppJwt(config, now);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims).toEqual({
      iss: "4242",
      iat: now / 1000 - 60,
      exp: now / 1000 + 540,
    });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(
      verifier.verify(publicKey, Buffer.from(signature, "base64url")),
    ).toBe(true);
  });

  it("reads the PR with a token narrowed to the repo and to read access", async () => {
    const gh = fakeGitHub();
    setMergeApprovalGitHubFetchForTests(gh.fetchImpl);
    const snap = await readPullRequestSnapshot({
      config,
      repo: "sagemathinc/cocalc-ai",
      pr_number: 12,
      budget: budget(),
    });
    expect(snap).toMatchObject({
      title: "Fix it",
      state: "open",
      draft: false,
      author: "agent",
      base_ref: "main",
      head_ref: "fix",
      head_sha: HEAD,
      changed_files: 1,
      files: [{ filename: "a.ts", additions: 1, deletions: 2 }],
      files_truncated: false,
      checks: [
        { name: "test", status: "completed", conclusion: "success" },
        { name: "ci/legacy", status: "pending", conclusion: null },
      ],
      reviews: [{ author: "codex", state: "COMMENTED", commit_id: HEAD }],
    });

    const [mint, ...reads] = gh.calls;
    expect(mint).toMatchObject({
      method: "POST",
      url: "/app/installations/99/access_tokens",
      body: {
        repositories: ["cocalc-ai"],
        permissions: {
          metadata: "read",
          pull_requests: "read",
          checks: "read",
          statuses: "read",
        },
      },
    });
    expect(mint.headers.Authorization).toMatch(
      /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/,
    );
    for (const call of reads) {
      expect(call.method).toBe("GET");
      expect(call.headers.Authorization).toBe(`Bearer ${INSTALLATION_TOKEN}`);
    }

    // The installation token is reused while it is valid.
    await readPullRequestSnapshot({
      config,
      repo: "sagemathinc/cocalc-ai",
      pr_number: 12,
      budget: budget(),
    });
    expect(gh.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("reports merged PRs as merged", async () => {
    const gh = fakeGitHub({ pr: { state: "closed", merged: true } });
    setMergeApprovalGitHubFetchForTests(gh.fetchImpl);
    const snap = await readPullRequestSnapshot({
      config,
      repo: "sagemathinc/cocalc-ai",
      pr_number: 12,
      budget: budget(),
    });
    expect(snap.state).toBe("merged");
  });

  it("caps the files list and the snapshot size", async () => {
    const files = Array.from({ length: 450 }, (_, i) => ({
      filename: `${"d/".repeat(200)}file-${i}.ts`,
      additions: i,
      deletions: 0,
    }));
    const gh = fakeGitHub({ files, pr: { changed_files: 450 } });
    setMergeApprovalGitHubFetchForTests(gh.fetchImpl);
    const snap = await readPullRequestSnapshot({
      config,
      repo: "sagemathinc/cocalc-ai",
      pr_number: 12,
      budget: budget(),
    });
    expect(snap.files.length).toBeLessThanOrEqual(300);
    expect(snap.files_truncated).toBe(true);
    expect(snap.changed_files).toBe(450);
    expect(Buffer.byteLength(JSON.stringify(snap))).toBeLessThanOrEqual(
      MAX_MERGE_APPROVAL_SNAPSHOT_BYTES,
    );
    // At most three pages are read.
    expect(gh.calls.filter((c) => c.url.includes("/files"))).toHaveLength(3);
  });

  it("refuses owners without an installation", async () => {
    const gh = fakeGitHub();
    setMergeApprovalGitHubFetchForTests(gh.fetchImpl);
    await expect(
      readPullRequestSnapshot({
        config,
        repo: "other/repo",
        pr_number: 1,
        budget: budget(),
      }),
    ).rejects.toThrow("no installation for other");
    expect(gh.calls).toHaveLength(0);
  });

  it("reports GitHub errors without the token", async () => {
    const gh = fakeGitHub({
      overrides: {
        "/repos/sagemathinc/cocalc-ai/pulls/12": () =>
          json({ message: "Resource not accessible by integration" }, 403),
      },
    });
    setMergeApprovalGitHubFetchForTests(gh.fetchImpl);
    const err = await readPullRequestSnapshot({
      config,
      repo: "sagemathinc/cocalc-ai",
      pr_number: 12,
      budget: budget(),
    }).catch((e) => e);
    expect(err.message).toBe(
      "GitHub GET /repos/sagemathinc/cocalc-ai/pulls/12 returned 403: Resource not accessible by integration",
    );
    expect(err.status).toBe(403);
    expect(err.message).not.toContain(INSTALLATION_TOKEN);
  });

  it("reads again when the head moves while the snapshot is read", async () => {
    let reads = 0;
    const gh = fakeGitHub({
      // The second PR read (the check after the first files page) sees a
      // push that is undone again before the end.
      pr: () =>
        ++reads === 2 ? { head: { ref: "fix", sha: "d".repeat(40) } } : {},
    });
    setMergeApprovalGitHubFetchForTests(gh.fetchImpl);
    const snap = await readPullRequestSnapshot({
      config,
      repo: "sagemathinc/cocalc-ai",
      pr_number: 12,
      budget: budget(),
    });
    expect(snap.head_sha).toBe(HEAD);
    expect(snap.base_sha).toBe(BASE);
    // PR, page check and final check; then all three again.
    expect(reads).toBe(6);
  });

  it("refuses a PR that keeps changing, or whose files don't add up", async () => {
    let reads = 0;
    const moving = fakeGitHub({
      pr: () => ({
        head: { ref: "fix", sha: (++reads % 2 ? "d" : "e").repeat(40) },
      }),
    });
    setMergeApprovalGitHubFetchForTests(moving.fetchImpl);
    await expect(
      readPullRequestSnapshot({
        config,
        repo: "sagemathinc/cocalc-ai",
        pr_number: 12,
        budget: budget(),
      }),
    ).rejects.toMatchObject({ code: "head_changed" });

    // The files list describes a different commit than the PR's totals.
    const mismatched = fakeGitHub({ pr: { additions: 99 } });
    setMergeApprovalGitHubFetchForTests(mismatched.fetchImpl);
    await expect(
      readPullRequestSnapshot({
        config,
        repo: "sagemathinc/cocalc-ai",
        pr_number: 12,
        budget: budget(),
      }),
    ).rejects.toMatchObject({ code: "head_changed" });
  });

  it("reads the current head in one request", async () => {
    const gh = fakeGitHub();
    setMergeApprovalGitHubFetchForTests(gh.fetchImpl);
    await expect(
      readPullRequestHead({
        config,
        repo: "sagemathinc/cocalc-ai",
        pr_number: 12,
        budget: budget(),
      }),
    ).resolves.toEqual({
      head_sha: HEAD,
      base_sha: BASE,
      base_ref: "main",
      state: "open",
      draft: false,
    });
    expect(gh.calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  it("refuses a shortened files list that exceeds the PR's totals", async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({
      filename: `f${i}.ts`,
      additions: 1,
      deletions: 0,
    }));
    const gh = fakeGitHub({
      files,
      pr: { changed_files: 400, additions: 10, deletions: 0 },
    });
    setMergeApprovalGitHubFetchForTests(gh.fetchImpl);
    await expect(
      readPullRequestSnapshot({
        config,
        repo: "sagemathinc/cocalc-ai",
        pr_number: 12,
        budget: budget(),
      }),
    ).rejects.toMatchObject({ code: "head_changed" });
  });

  it("summarizes checks and reviews and says when lists are shortened", async () => {
    // The failure and the change request are on the second pages.
    const runs = Array.from({ length: 140 }, (_, i) => ({
      name: `${"x".repeat(150)}-${i}`,
      status: "completed",
      conclusion: i === 120 ? "failure" : "success",
    }));
    const reviews = Array.from({ length: 150 }, (_, i) => ({
      user: { login: `r${i}` },
      state: i === 130 ? "CHANGES_REQUESTED" : "COMMENTED",
      commit_id: HEAD,
    }));
    const gh = fakeGitHub({
      checkRuns: runs,
      reviews,
      files: Array.from({ length: 300 }, (_, i) => ({
        filename: `${"d/".repeat(200)}f${i}.ts`,
        additions: 0,
        deletions: 0,
      })),
      pr: { changed_files: 300 },
    });
    setMergeApprovalGitHubFetchForTests(gh.fetchImpl);
    const snap = await readPullRequestSnapshot({
      config,
      repo: "sagemathinc/cocalc-ai",
      pr_number: 12,
      budget: budget(),
    });
    expect(snap.check_summary).toEqual({
      total: 141,
      counted: 141,
      failing: 1,
      pending: 1,
    });
    expect(snap.review_summary).toEqual({
      total: 150,
      changes_requested: 1,
      approved: 0,
      complete: true,
    });
    // All pages were read, so a list is marked shortened exactly when the
    // size cap shortened it.
    expect(snap.checks_truncated).toBe(snap.checks.length < 141);
    expect(snap.reviews_truncated).toBe(snap.reviews.length < 150);
    // Whatever was shortened, failures and change requests come first.
    if (snap.checks.length < 141) {
      expect(snap.checks[0]).toMatchObject({ conclusion: "failure" });
    }
    if (snap.reviews.length < 150) {
      expect(snap.reviews[0]).toMatchObject({ state: "CHANGES_REQUESTED" });
    }
    expect(Buffer.byteLength(JSON.stringify(snap))).toBeLessThanOrEqual(
      MAX_MERGE_APPROVAL_SNAPSHOT_BYTES,
    );
  });

  it("marks review counts as partial past the page cap", async () => {
    const reviews = Array.from({ length: 1100 }, (_, i) => ({
      user: { login: `r${i}` },
      state: i === 1050 ? "CHANGES_REQUESTED" : "COMMENTED",
      commit_id: HEAD,
    }));
    const gh = fakeGitHub({ reviews });
    setMergeApprovalGitHubFetchForTests(gh.fetchImpl);
    const snap = await readPullRequestSnapshot({
      config,
      repo: "sagemathinc/cocalc-ai",
      pr_number: 12,
      budget: budget(),
    });
    expect(snap.review_summary).toMatchObject({
      total: 300,
      changes_requested: 0,
      complete: false,
    });
    expect(snap.reviews_truncated).toBe(true);
  });

  it("stays within the per-attempt call budget for the largest PR it reads", async () => {
    const many = (n: number, f: (i: number) => any) =>
      Array.from({ length: n }, (_, i) => f(i));
    const gh = fakeGitHub({
      files: many(450, (i) => ({
        filename: `f${i}`,
        additions: 1,
        deletions: 0,
      })),
      pr: { changed_files: 450, additions: 450, deletions: 0 },
      checkRuns: many(500, (i) => ({
        name: `c${i}`,
        status: "completed",
        conclusion: "success",
      })),
      reviews: many(500, (i) => ({
        user: { login: `r${i}` },
        state: "COMMENTED",
        commit_id: HEAD,
      })),
    });
    setMergeApprovalGitHubFetchForTests(gh.fetchImpl);
    const b = gitHubBudget({ max_calls: 40, timeout_ms: 60_000 });
    await readPullRequestSnapshot({
      config,
      repo: "sagemathinc/cocalc-ai",
      pr_number: 12,
      budget: b,
    });
    // This read: 1 mint + 1 PR + 3 file pages with 3 head checks + 3
    // check-run pages + 1 status page (there is one status) + 3 review pages
    // + 1 final head check. The worst case is 18 (3 status pages), or about
    // 36 with the one retry and the head re-check under the lock: within
    // the 40 an attempt may use.
    expect(gh.calls).toHaveLength(16);
    expect(b.calls_left).toBe(24);
  });

  it("stops when the attempt's budget runs out", async () => {
    const gh = fakeGitHub();
    setMergeApprovalGitHubFetchForTests(gh.fetchImpl);
    await expect(
      readPullRequestSnapshot({
        config,
        repo: "sagemathinc/cocalc-ai",
        pr_number: 12,
        budget: gitHubBudget({ max_calls: 3, timeout_ms: 60_000 }),
      }),
    ).rejects.toMatchObject({ code: "github_budget_exceeded" });
    expect(gh.calls).toHaveLength(3);
    await expect(
      readPullRequestHead({
        config,
        repo: "sagemathinc/cocalc-ai",
        pr_number: 12,
        budget: gitHubBudget({ max_calls: 10, timeout_ms: -1 }),
      }),
    ).rejects.toMatchObject({ code: "github_budget_exceeded" });
  });
});
