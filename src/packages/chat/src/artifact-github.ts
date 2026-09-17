/** Bounded cached PR data. Never contains GitHub credentials or executable actions. */
export interface ArtifactGitHubPR {
  repository: string;
  number: number;
  state: "open" | "closed" | "merged";
  draft: boolean;
  fetched_at: string;
  base_sha: string;
  head_sha: string;
  checks: "unknown" | "pending" | "passing" | "failing";
  local?: { path: string; common_directory: string };
}

export function validateArtifactGitHubPR(value: unknown): ArtifactGitHubPR {
  const row = value as ArtifactGitHubPR;
  if (
    !row ||
    typeof row.repository !== "string" ||
    row.repository.length > 256 ||
    !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(row.repository) ||
    [".", ".."].includes(row.repository.split("/")[1]) ||
    !Number.isSafeInteger(row.number) ||
    row.number < 1
  )
    throw Error("invalid GitHub PR identity");
  if (
    !["open", "closed", "merged"].includes(row.state) ||
    typeof row.draft !== "boolean" ||
    !["unknown", "pending", "passing", "failing"].includes(row.checks)
  )
    throw Error("invalid GitHub PR status");
  if (
    typeof row.fetched_at !== "string" ||
    row.fetched_at.length > 32 ||
    !Number.isFinite(Date.parse(row.fetched_at))
  )
    throw Error("invalid GitHub PR retrieval time");
  if (
    ![row.base_sha, row.head_sha].every(
      (sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha),
    )
  )
    throw Error("GitHub PR revisions must be full commit SHAs");
  let local: ArtifactGitHubPR["local"];
  if (row.local !== undefined) {
    for (const path of [row.local?.path, row.local?.common_directory]) {
      if (
        typeof path !== "string" ||
        !path.startsWith("/") ||
        path.length > 4096 ||
        /[\x00-\x1f\x7f\\]/.test(path) ||
        path.split("/").includes("..")
      )
        throw Error("invalid GitHub PR local repository path");
    }
    local = {
      path: row.local.path,
      common_directory: row.local.common_directory,
    };
  }
  return {
    repository: row.repository,
    number: row.number,
    state: row.state,
    draft: row.draft,
    fetched_at: row.fetched_at,
    base_sha: row.base_sha,
    head_sha: row.head_sha,
    checks: row.checks,
    ...(local ? { local } : {}),
  };
}

export function artifactGitHubPRUrl(value: ArtifactGitHubPR): string {
  const pr = validateArtifactGitHubPR(value);
  return `https://github.com/${pr.repository}/pull/${pr.number}`;
}
