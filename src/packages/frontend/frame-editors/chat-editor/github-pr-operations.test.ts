import {
  githubRemoteRepository,
  verifyPRCommits,
  fetchPRCommits,
  refreshPR,
} from "./github-pr-operations";
import { webapp_client } from "@cocalc/frontend/webapp-client";
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { project_client: { exec: jest.fn() } },
}));
const exec = webapp_client.project_client.exec as jest.Mock;
const pr: any = {
  repository: "sagemathinc/cocalc-ai",
  number: 509,
  state: "open",
  draft: true,
  fetched_at: "2026-09-10T00:00:00Z",
  checks: "unknown",
  base_sha: "a".repeat(40),
  head_sha: "b".repeat(40),
  local: { path: "/worktree", common_directory: "/repo/.git" },
};
beforeEach(() => {
  exec.mockReset();
});
function repository(remote = "git@github.com:sagemathinc/cocalc-ai.git") {
  exec
    .mockResolvedValueOnce({ exit_code: 0, stdout: "/repo/.git\n" })
    .mockResolvedValueOnce({
      exit_code: 0,
      stdout: `origin\t${remote} (fetch)\n`,
    });
}
test("recognizes exact GitHub remotes, not lookalike hosts or paths", () => {
  expect(
    githubRemoteRepository("https://github.com/SageMathInc/cocalc-ai.git"),
  ).toBe("sagemathinc/cocalc-ai");
  expect(
    githubRemoteRepository("ssh://git@github.com/sagemathinc/cocalc-ai.git"),
  ).toBe(pr.repository);
  expect(
    githubRemoteRepository(
      "https://github.com.evil.example/sagemathinc/cocalc-ai.git",
    ),
  ).toBeUndefined();
  expect(
    githubRemoteRepository("https://github.com/sagemathinc/cocalc-ai/extra"),
  ).toBeUndefined();
});
test("checks repository identity and both immutable commits without fetching", async () => {
  repository();
  exec.mockResolvedValue({ exit_code: 0, stdout: "" });
  expect(await verifyPRCommits("project", pr)).toEqual(pr);
  expect(exec.mock.calls.map(([o]) => o.args[0])).toEqual([
    "rev-parse",
    "remote",
    "cat-file",
    "cat-file",
  ]);
  expect(
    exec.mock.calls.every(
      ([o]) =>
        o.project_id === "project" &&
        o.path === "/worktree" &&
        o.bash === false,
    ),
  ).toBe(true);
});
test("rejects a different repository without inspecting or fetching commits", async () => {
  repository("https://github.com/other/repo.git");
  await expect(verifyPRCommits("project", pr)).rejects.toThrow(
    "No fetch remote matches",
  );
  expect(exec).toHaveBeenCalledTimes(2);
});
test("fetch explicitly downloads pinned SHAs without updating branches", async () => {
  repository();
  exec.mockResolvedValueOnce({ exit_code: 0, stdout: "" });
  repository();
  exec.mockResolvedValue({ exit_code: 0, stdout: "" });
  await fetchPRCommits("project", pr);
  expect(exec.mock.calls[2][0].args).toEqual([
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    "https://github.com/sagemathinc/cocalc-ai.git",
    pr.base_sha,
    pr.head_sha,
  ]);
});
test("refresh normalizes GitHub metadata and conservatively reports pending checks", async () => {
  exec.mockResolvedValue({
    exit_code: 0,
    stdout: JSON.stringify({
      title: "PR title",
      body: "PR body",
      state: "open",
      draft: false,
      base_sha: pr.base_sha,
      head_sha: pr.head_sha,
      headRefOid: pr.head_sha,
      statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: "" }],
    }),
  });
  const next = await refreshPR("project", pr);
  expect(next).toMatchObject({
    title: "PR title",
    input: "PR body",
    github_pr: { checks: "pending", draft: false, state: "open" },
  });
  expect(exec.mock.calls[0][0].args).toContain(
    "repos/sagemathinc/cocalc-ai/pulls/509",
  );
});

test("checks for a newer head are not attributed to the fetched PR revision", async () => {
  exec
    .mockResolvedValueOnce({
      exit_code: 0,
      stdout: JSON.stringify({
        title: "Title",
        body: null,
        state: "closed",
        merged: true,
        draft: false,
        base_sha: pr.base_sha,
        head_sha: pr.head_sha,
      }),
    })
    .mockResolvedValueOnce({
      exit_code: 0,
      stdout: JSON.stringify({
        headRefOid: "c".repeat(40),
        statusCheckRollup: [{ conclusion: "SUCCESS" }],
      }),
    });
  expect(await refreshPR("project", pr)).toMatchObject({
    input: "",
    github_pr: { state: "merged", checks: "unknown", head_sha: pr.head_sha },
  });
});

test("missing commits report a fetch option without an automatic fetch", async () => {
  repository();
  exec.mockResolvedValueOnce({ exit_code: 1, stdout: "" });
  await expect(verifyPRCommits("project", pr)).rejects.toThrow(
    "Fetch PR commits explicitly",
  );
  expect(exec).toHaveBeenCalledTimes(3);
});

test("missing project gh explains the prerequisite without exposing raw spawn output", async () => {
  exec.mockRejectedValueOnce(
    Error("spawn gh ENOENT verbose internal command data"),
  );
  await expect(refreshPR("project", pr)).rejects.toThrow(
    "GitHub CLI (gh) was not found on the project's command PATH",
  );
  expect(exec).toHaveBeenCalledTimes(1);
});
