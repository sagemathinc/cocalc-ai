/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { createVerify, generateKeyPairSync } from "node:crypto";
import { MAX_MERGE_APPROVAL_SNAPSHOT_BYTES } from "@cocalc/util/merge-approval";
import {
  mergeApprovalAppJwt,
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
}: {
  pr?: Record<string, unknown>;
  files?: any[];
  overrides?: Record<string, () => Response>;
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
        base: { ref: "main" },
        head: { ref: "fix", sha: HEAD },
        html_url: "https://github.com/sagemathinc/cocalc-ai/pull/12",
        additions: 10,
        deletions: 3,
        changed_files: files.length,
        ...pr,
      });
    }
    if (base === "/repos/sagemathinc/cocalc-ai/pulls/12/files") {
      const page = Number(new URL(url).searchParams.get("page"));
      return json(files.slice((page - 1) * 100, page * 100));
    }
    if (base === `/repos/sagemathinc/cocalc-ai/commits/${HEAD}/check-runs`) {
      return json({
        check_runs: [
          { name: "test", status: "completed", conclusion: "success" },
        ],
      });
    }
    if (base === `/repos/sagemathinc/cocalc-ai/commits/${HEAD}/status`) {
      return json({ statuses: [{ context: "ci/legacy", state: "pending" }] });
    }
    if (base === "/repos/sagemathinc/cocalc-ai/pulls/12/reviews") {
      return json([
        { user: { login: "codex" }, state: "COMMENTED", commit_id: HEAD },
      ]);
    }
    return json({ message: "Not Found" }, 404);
  };
  return { calls, fetchImpl };
}

afterEach(() => setMergeApprovalGitHubFetchForTests());

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
      readPullRequestSnapshot({ config, repo: "other/repo", pr_number: 1 }),
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
    }).catch((e) => e);
    expect(err.message).toBe(
      "GitHub GET /repos/sagemathinc/cocalc-ai/pulls/12 returned 403: Resource not accessible by integration",
    );
    expect(err.status).toBe(403);
    expect(err.message).not.toContain(INSTALLATION_TOKEN);
  });
});
