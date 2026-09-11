import type { ArtifactGitHubPR } from "@cocalc/chat";
import { validateArtifactGitHubPR } from "@cocalc/chat";
import { webapp_client } from "@cocalc/frontend/webapp-client";

async function run(
  projectId: string,
  path: string,
  command: string,
  args: string[],
) {
  const result = await webapp_client.project_client
    .exec({
      project_id: projectId,
      path,
      command,
      args,
      bash: false,
      err_on_exit: false,
      max_output: 128 * 1024,
      timeout: 60,
    })
    .catch((err) => {
      if (command === "gh" && String(err).includes("ENOENT"))
        throw Error(
          "GitHub CLI (gh) was not found on the project's command PATH. Install it in the project and sign in with gh auth login, then retry Refresh. Cached PR data is still available.",
        );
      throw Error(
        `${command} could not run in this project. Check project availability and command access in a terminal.`,
      );
    });
  if (result.exit_code !== 0)
    throw Error(
      `${command} operation failed. Check project access and credentials in a terminal.`,
    );
  return result.stdout;
}

export function githubRemoteRepository(remote: string): string | undefined {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+?)\/?$/.exec(
      remote.trim(),
    );
  return match?.[1].replace(/\.git$/, "").toLowerCase();
}

export async function verifyPRRepository(
  projectId: string,
  value: ArtifactGitHubPR,
) {
  const pr = validateArtifactGitHubPR(value);
  if (!pr.local) throw Error("No local repository is associated with this PR.");
  const git = (args: string[]) => run(projectId, pr.local!.path, "git", args);
  const common = (
    await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])
  ).trim();
  if (common !== pr.local.common_directory)
    throw Error(
      "The local Git directory has changed. Update the artifact's repository association before reviewing.",
    );
  const remotes = await git(["remote", "-v"]);
  const matched = remotes.split("\n").some((line) => {
    const fields = line.trim().split(/\s+/);
    return (
      fields[2] === "(fetch)" &&
      githubRemoteRepository(fields[1] ?? "") === pr.repository.toLowerCase()
    );
  });
  if (!matched)
    throw Error(
      `No fetch remote matches ${pr.repository} in the associated local repository.`,
    );
  return pr;
}

export async function verifyPRCommits(
  projectId: string,
  value: ArtifactGitHubPR,
) {
  const pr = await verifyPRRepository(projectId, value);
  for (const sha of [pr.base_sha, pr.head_sha]) {
    try {
      await run(projectId, pr.local!.path, "git", [
        "cat-file",
        "-e",
        `${sha}^{commit}`,
      ]);
    } catch {
      throw Error(
        "PR commits are not available locally. Fetch PR commits explicitly, then retry review.",
      );
    }
  }
  return pr;
}

export async function fetchPRCommits(
  projectId: string,
  value: ArtifactGitHubPR,
) {
  const pr = await verifyPRRepository(projectId, value);
  await run(projectId, pr.local!.path, "git", [
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    `https://github.com/${pr.repository}.git`,
    pr.base_sha,
    pr.head_sha,
  ]);
  return await verifyPRCommits(projectId, pr);
}

export async function refreshPR(projectId: string, value: ArtifactGitHubPR) {
  const pr = validateArtifactGitHubPR(value);
  // GitHub requests identify the repository explicitly; a local worktree may
  // have been removed since publication and is needed only for local review.
  const text = await run(projectId, ".", "gh", [
    "api",
    "--hostname",
    "github.com",
    `repos/${pr.repository}/pulls/${pr.number}`,
    "--jq",
    "{title,body,state,draft,merged,base_sha:.base.sha,head_sha:.head.sha}",
  ]);
  const data = JSON.parse(text);
  if (
    typeof data.title !== "string" ||
    (data.body !== null && typeof data.body !== "string")
  )
    throw Error("GitHub returned invalid PR text.");
  let checks: any[] = [];
  try {
    const rollup = JSON.parse(
      await run(projectId, ".", "gh", [
        "pr",
        "view",
        String(pr.number),
        "--repo",
        `github.com/${pr.repository}`,
        "--json",
        "headRefOid,statusCheckRollup",
      ]),
    );
    // A force-push between requests must not attach new checks to the old head.
    if (
      rollup.headRefOid === data.head_sha &&
      Array.isArray(rollup.statusCheckRollup)
    )
      checks = rollup.statusCheckRollup;
  } catch {
    // Metadata is still useful if this credential cannot read check results.
  }
  const states = checks.map(
    (item) => item?.conclusion || item?.state || item?.status,
  );
  const status = !states.length
    ? "unknown"
    : states.some((s) =>
          [
            "FAILURE",
            "ERROR",
            "TIMED_OUT",
            "CANCELLED",
            "ACTION_REQUIRED",
            "STARTUP_FAILURE",
            "STALE",
          ].includes(s),
        )
      ? "failing"
      : states.every((s) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(s))
        ? "passing"
        : "pending";
  return {
    title: data.title,
    input: data.body ?? "",
    github_pr: validateArtifactGitHubPR({
      ...pr,
      state: data.merged === true ? "merged" : data.state,
      draft: data.draft,
      base_sha: data.base_sha,
      head_sha: data.head_sha,
      checks: status,
      fetched_at: new Date().toISOString(),
    }),
  };
}
