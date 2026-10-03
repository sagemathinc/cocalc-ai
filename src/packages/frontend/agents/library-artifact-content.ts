/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// What "New Artifact" publishes: building it from the form, and looking up
// GitHub pull requests. No chat or project code here.

import type { PublishArtifactInput } from "@cocalc/chat";

export type NewArtifactContent = Pick<
  PublishArtifactInput,
  "title" | "markdown" | "file" | "github_pr" | "actions"
>;

// GitHub PR artifacts need the PR's current state and full revision SHAs;
// read them from GitHub's public API (works for public repositories).
export async function fetchGitHubPR(url: string) {
  const m = url
    .trim()
    .match(/github\.com\/([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/);
  if (!m) throw Error("Enter a GitHub pull request URL");
  const [, repository, number] = m;
  const response = await fetch(
    `https://api.github.com/repos/${repository}/pulls/${number}`,
    { headers: { Accept: "application/vnd.github+json" } },
  );
  if (!response.ok)
    throw Error(
      response.status === 404
        ? "Pull request not found (private repositories are not supported here)"
        : `GitHub returned ${response.status}`,
    );
  const pr = await response.json();
  return {
    title: `${pr.title ?? `${repository}#${number}`}`,
    github_pr: {
      repository,
      number: Number(number),
      state: pr.merged_at
        ? "merged"
        : pr.state === "closed"
          ? "closed"
          : "open",
      draft: !!pr.draft,
      fetched_at: new Date().toISOString(),
      base_sha: pr.base?.sha,
      head_sha: pr.head?.sha,
      checks: "unknown",
    } as NonNullable<NewArtifactContent["github_pr"]>,
    markdown: `${pr.body ?? ""}`.slice(0, 4000),
  };
}

export type NewArtifactKind = "markdown" | "file" | "github-pr" | "actions";

// Turn the New Artifact form into publishable content; throws a message
// suitable for the form when something is missing.
export function buildArtifactContent(
  kind: NewArtifactKind,
  fields: {
    title: string;
    markdown?: string;
    path?: string;
    decisions?: string;
    pr?: Awaited<ReturnType<typeof fetchGitHubPR>>;
  },
): NewArtifactContent {
  const title = fields.title.trim();
  switch (kind) {
    case "markdown":
      if (!title) throw Error("Give the document a title.");
      return { title, markdown: fields.markdown ?? "" };
    case "file": {
      const path = `${fields.path ?? ""}`.trim();
      if (!path) throw Error("Enter the path of a file in the project.");
      return {
        title: title || path.split("/").pop() || path,
        markdown: fields.markdown ?? "",
        file: { path },
      };
    }
    case "github-pr":
      if (!fields.pr) throw Error("Look up the pull request first.");
      return {
        title: title || fields.pr.title,
        markdown: fields.pr.markdown,
        github_pr: fields.pr.github_pr,
      };
    case "actions": {
      const lines = `${fields.decisions ?? ""}`
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length === 0)
        throw Error("Add at least one item, one per line.");
      if (lines.length > 20)
        throw Error("A decision list has at most 20 items.");
      return {
        title: title || "Decisions",
        markdown: fields.markdown ?? "",
        actions: lines.map((line, i) => ({
          id: `item-${i + 1}`,
          title: line.slice(0, 256),
          target: "",
          draft: "",
        })),
      };
    }
  }
}
