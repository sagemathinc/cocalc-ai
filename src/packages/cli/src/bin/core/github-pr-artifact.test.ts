import assert from "node:assert/strict";
import test from "node:test";
import {
  githubPrArtifactPayload,
  githubRepositoryFromRemote,
  parseGitHubPrRef,
  summarizeCheckRuns,
  type CommandRunner,
} from "./github-pr-artifact";

const HEAD = "b".repeat(40);
const BASE = "a".repeat(40);

function fakeRunner(
  overrides: { remotes?: string; pr?: any; checks?: any; noGit?: boolean } = {},
): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "git") {
      if (overrides.noGit) throw Error("not a git repository");
      if (args[0] === "remote")
        return (
          overrides.remotes ??
          "origin\tgit@github.com:sagemathinc/cocalc-ai.git (fetch)\norigin\tgit@github.com:sagemathinc/cocalc-ai.git (push)"
        );
      if (args.includes("--show-toplevel")) return "/home/user/cocalc-ai";
      return "/home/user/cocalc-ai/.git";
    }
    if (args[1].includes("/check-runs")) {
      if (overrides.checks instanceof Error) throw overrides.checks;
      return JSON.stringify(overrides.checks ?? { check_runs: [] });
    }
    return JSON.stringify(
      overrides.pr ?? {
        number: 792,
        title: "chat: icons",
        body: "First paragraph.\n\nSecond paragraph.",
        state: "open",
        draft: false,
        merged_at: null,
        base: { sha: BASE },
        head: { sha: HEAD },
      },
    );
  };
  return { run, calls };
}

test("parses PR references", () => {
  assert.deepEqual(parseGitHubPrRef("792"), { number: 792 });
  assert.deepEqual(parseGitHubPrRef("#792"), { number: 792 });
  assert.deepEqual(parseGitHubPrRef("sagemathinc/cocalc-ai#792"), {
    repository: "sagemathinc/cocalc-ai",
    number: 792,
  });
  assert.deepEqual(
    parseGitHubPrRef("https://github.com/sagemathinc/cocalc-ai/pull/792/files"),
    { repository: "sagemathinc/cocalc-ai", number: 792 },
  );
  for (const bad of ["", "0", "abc", "https://example.com/a/b/pull/1"])
    assert.throws(() => parseGitHubPrRef(bad), /--github-pr expects/);
});

test("recognizes GitHub remotes only", () => {
  assert.equal(
    githubRepositoryFromRemote("git@github.com:sagemathinc/cocalc-ai.git"),
    "sagemathinc/cocalc-ai",
  );
  assert.equal(
    githubRepositoryFromRemote("https://github.com/sagemathinc/cocalc-ai"),
    "sagemathinc/cocalc-ai",
  );
  assert.equal(
    githubRepositoryFromRemote("https://gitlab.com/a/b.git"),
    undefined,
  );
});

test("summarizes check runs", () => {
  assert.equal(summarizeCheckRuns([]), "unknown");
  assert.equal(
    summarizeCheckRuns([{ status: "completed", conclusion: "success" }]),
    "passing",
  );
  assert.equal(
    summarizeCheckRuns([
      { status: "completed", conclusion: "success" },
      { status: "in_progress", conclusion: null },
    ]),
    "pending",
  );
  assert.equal(
    summarizeCheckRuns([
      { status: "in_progress", conclusion: null },
      { status: "completed", conclusion: "failure" },
    ]),
    "failing",
  );
});

test("builds a complete PR card from the local clone's GitHub repository", async () => {
  const { run, calls } = fakeRunner({
    checks: { check_runs: [{ status: "completed", conclusion: "success" }] },
  });
  const payload = await githubPrArtifactPayload({
    ref: "792",
    repoDir: "/home/user/cocalc-ai",
    run,
    now: () => new Date("2026-10-01T00:00:00.000Z"),
  });
  assert.deepEqual(payload, {
    title: "#792 chat: icons",
    markdown: "First paragraph.",
    github_pr: {
      repository: "sagemathinc/cocalc-ai",
      number: 792,
      state: "open",
      draft: false,
      fetched_at: "2026-10-01T00:00:00.000Z",
      base_sha: BASE,
      head_sha: HEAD,
      checks: "passing",
      local: {
        path: "/home/user/cocalc-ai",
        common_directory: "/home/user/cocalc-ai/.git",
      },
    },
  });
  assert.ok(
    calls.some((c) =>
      c.join(" ").includes("api repos/sagemathinc/cocalc-ai/pulls/792"),
    ),
  );
});

test("marks merged PRs, omits an unrelated clone and tolerates missing checks", async () => {
  const { run } = fakeRunner({
    remotes: "origin\thttps://github.com/someone/else.git (fetch)",
    checks: Error("no access"),
    pr: {
      number: 5,
      title: "t",
      body: null,
      state: "closed",
      draft: true,
      merged_at: "2026-09-01T00:00:00Z",
      base: { sha: BASE },
      head: { sha: HEAD },
    },
  });
  const payload = await githubPrArtifactPayload({
    ref: "sagemathinc/cocalc-ai#5",
    repoDir: "/tmp",
    run,
  });
  assert.equal(payload.github_pr.state, "merged");
  assert.equal(payload.github_pr.draft, true);
  assert.equal(payload.github_pr.checks, "unknown");
  assert.equal(payload.github_pr.local, undefined);
  assert.equal(payload.markdown, "");
});

test("explains how to name the repository when it cannot be inferred", async () => {
  const { run } = fakeRunner({ noGit: true });
  await assert.rejects(
    githubPrArtifactPayload({ ref: "12", repoDir: "/tmp", run }),
    /Use owner\/name#12 or the PR URL/,
  );
});
