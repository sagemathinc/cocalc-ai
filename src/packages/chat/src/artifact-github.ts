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

const GITHUB_PR_HINT =
  " (cocalc project chat artifact publish --github-pr <number> fills these in)";

function invalid(field: string, requirement: string, value: unknown): Error {
  const shown =
    value === undefined
      ? "missing"
      : `got ${JSON.stringify(value)?.slice(0, 80)}`;
  return Error(`github_pr.${field} ${requirement}; ${shown}${GITHUB_PR_HINT}`);
}

export function validateArtifactGitHubPR(value: unknown): ArtifactGitHubPR {
  const row = value as ArtifactGitHubPR;
  if (!row || typeof row !== "object")
    throw Error(`github_pr must be an object${GITHUB_PR_HINT}`);
  if (
    typeof row.repository !== "string" ||
    row.repository.length > 256 ||
    !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(row.repository) ||
    [".", ".."].includes(row.repository.split("/")[1])
  )
    throw invalid(
      "repository",
      'must be "owner/name", such as "sagemathinc/cocalc-ai"',
      row.repository,
    );
  if (!Number.isSafeInteger(row.number) || row.number < 1)
    throw invalid("number", "must be a positive integer", row.number);
  if (!["open", "closed", "merged"].includes(row.state))
    throw invalid("state", 'must be "open", "closed" or "merged"', row.state);
  if (typeof row.draft !== "boolean")
    throw invalid("draft", "must be true or false", row.draft);
  if (!["unknown", "pending", "passing", "failing"].includes(row.checks))
    throw invalid(
      "checks",
      'must be "unknown", "pending", "passing" or "failing"',
      row.checks,
    );
  if (
    typeof row.fetched_at !== "string" ||
    row.fetched_at.length > 32 ||
    !Number.isFinite(Date.parse(row.fetched_at))
  )
    throw invalid(
      "fetched_at",
      "must be an ISO timestamp of when the PR was read",
      row.fetched_at,
    );
  for (const field of ["base_sha", "head_sha"] as const) {
    const sha = row[field];
    if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha))
      throw invalid(field, "must be a full 40-character commit SHA", sha);
  }
  let local: ArtifactGitHubPR["local"];
  if (row.local !== undefined) {
    for (const field of ["path", "common_directory"] as const) {
      const path = row.local?.[field];
      if (
        typeof path !== "string" ||
        !path.startsWith("/") ||
        path.length > 4096 ||
        /[\x00-\x1f\x7f\\]/.test(path) ||
        path.split("/").includes("..")
      )
        throw invalid(
          `local.${field}`,
          "must be an absolute path without .. or control characters",
          path,
        );
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
