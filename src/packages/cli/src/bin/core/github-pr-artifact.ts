/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Builds a GitHub PR artifact payload from GitHub itself (via the gh CLI), so
// agents never assemble state, SHAs, timestamps or check status by hand.

export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<string>;

const REF_HELP =
  "--github-pr expects a PR number (123 or #123), owner/name#123, or a https://github.com/owner/name/pull/123 URL";

export function parseGitHubPrRef(ref: string): {
  repository?: string;
  number: number;
} {
  const value = `${ref}`.trim();
  let match = value.match(/^#?(\d+)$/);
  if (match) return { number: positive(match[1]) };
  match = value.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (match) return { repository: match[1], number: positive(match[2]) };
  match = value.match(
    /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/,
  );
  if (match) return { repository: match[1], number: positive(match[2]) };
  throw Error(REF_HELP);
}

function positive(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw Error(REF_HELP);
  return number;
}

export function githubRepositoryFromRemote(url: string): string | undefined {
  const match = url
    .trim()
    .match(
      /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/,
    );
  return match?.[1];
}

export function summarizeCheckRuns(
  runs: { status?: string; conclusion?: string | null }[],
): "unknown" | "pending" | "passing" | "failing" {
  if (!runs.length) return "unknown";
  if (
    runs.some((run) =>
      ["failure", "cancelled", "timed_out", "action_required"].includes(
        `${run.conclusion}`,
      ),
    )
  )
    return "failing";
  if (runs.some((run) => run.status !== "completed")) return "pending";
  return "passing";
}

function firstParagraph(body: unknown): string {
  const text = typeof body === "string" ? body.trim() : "";
  const paragraph = text.split(/\n\s*\n/)[0]?.trim() ?? "";
  return paragraph.length > 600 ? `${paragraph.slice(0, 597)}...` : paragraph;
}

async function localRepository(
  run: CommandRunner,
  cwd: string,
): Promise<
  { path: string; common_directory: string; repositories: string[] } | undefined
> {
  try {
    const path = await run("git", ["rev-parse", "--show-toplevel"], cwd);
    const common_directory = await run(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      cwd,
    );
    const remotes = await run("git", ["remote", "-v"], cwd);
    const origin: string[] = [];
    const others: string[] = [];
    for (const line of remotes.split("\n")) {
      const [name, url] = line.trim().split(/\s+/);
      const repository = url && githubRepositoryFromRemote(url);
      if (!repository) continue;
      const list = name === "origin" ? origin : others;
      if (!list.includes(repository)) list.push(repository);
    }
    return { path, common_directory, repositories: [...origin, ...others] };
  } catch {
    return undefined;
  }
}

export async function githubPrArtifactPayload({
  ref,
  repoDir,
  run,
  now = () => new Date(),
}: {
  ref: string;
  repoDir: string;
  run: CommandRunner;
  now?: () => Date;
}): Promise<{ title: string; markdown: string; github_pr: any }> {
  const parsed = parseGitHubPrRef(ref);
  const local = await localRepository(run, repoDir);
  const repository = parsed.repository ?? local?.repositories[0];
  if (!repository)
    throw Error(
      `could not tell which GitHub repository PR ${parsed.number} is in: ${repoDir} has no GitHub remote. Use owner/name#${parsed.number} or the PR URL, or pass --repo <clone>.`,
    );
  let pr: any;
  try {
    pr = JSON.parse(
      await run(
        "gh",
        ["api", `repos/${repository}/pulls/${parsed.number}`],
        repoDir,
      ),
    );
  } catch (error) {
    throw Error(
      `could not read ${repository}#${parsed.number} with the GitHub CLI (gh): ${(error as Error)?.message ?? error}`,
    );
  }
  let checks: "unknown" | "pending" | "passing" | "failing" = "unknown";
  try {
    const result = JSON.parse(
      await run(
        "gh",
        [
          "api",
          `repos/${repository}/commits/${pr.head.sha}/check-runs?per_page=100`,
        ],
        repoDir,
      ),
    );
    checks = summarizeCheckRuns(result?.check_runs ?? []);
  } catch {
    // Check status is optional; the card shows "unknown".
  }
  const sameRepository =
    local &&
    local.repositories.some(
      (name) => name.toLowerCase() === repository.toLowerCase(),
    );
  return {
    title: `#${pr.number} ${pr.title}`,
    markdown: firstParagraph(pr.body),
    github_pr: {
      repository,
      number: pr.number,
      state: pr.merged_at
        ? "merged"
        : pr.state === "closed"
          ? "closed"
          : "open",
      draft: pr.draft === true,
      fetched_at: now().toISOString(),
      base_sha: pr.base.sha,
      head_sha: pr.head.sha,
      checks,
      ...(sameRepository
        ? {
            local: {
              path: local.path,
              common_directory: local.common_directory,
            },
          }
        : {}),
    },
  };
}
