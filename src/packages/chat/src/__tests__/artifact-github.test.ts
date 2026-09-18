import {
  artifactGitHubPRUrl,
  validateArtifactGitHubPR,
} from "../artifact-github";
import { publishArtifact } from "../artifacts";

const pr = {
  repository: "sagemathinc/cocalc-ai",
  number: 509,
  state: "open",
  draft: true,
  fetched_at: "2026-09-10T00:00:00.000Z",
  base_sha: "a".repeat(40),
  head_sha: "b".repeat(40),
  checks: "pending",
};

test("PR metadata participates in immutable publications and update bases", () => {
  const rows = new Map<string, any>();
  const key = (row) =>
    JSON.stringify([row.event, row.sender_id, row.thread_id]);
  const store = {
    get_one: (row) => rows.get(key(row)),
    set: (batch) => {
      for (const row of batch) rows.set(key(row), row);
    },
  };
  const input = {
    thread_id: "thread",
    artifact_id: "pr",
    operation_id: "first",
    message_id: "message",
    title: "PR",
    markdown: "Description",
    github_pr: validateArtifactGitHubPR(pr),
  };
  const first = publishArtifact(store, input);
  expect(first.artifact.kind).toBe("github-pr");
  expect(publishArtifact(store, input).replayed).toBe(true);
  const next = publishArtifact(store, {
    ...input,
    base: first.base,
    operation_id: "refresh",
    github_pr: { ...input.github_pr, head_sha: "c".repeat(40) },
  });
  expect(next.base).not.toBe(first.base);
  expect(first.publication.snapshot.github_pr?.head_sha).toBe(pr.head_sha);
});
test("retains only bounded cached metadata and constructs the external URL", () => {
  expect(
    validateArtifactGitHubPR({ ...pr, token: "never persist this" }),
  ).toEqual(pr);
  expect(artifactGitHubPRUrl(validateArtifactGitHubPR(pr))).toBe(
    "https://github.com/sagemathinc/cocalc-ai/pull/509",
  );
});
test.each([
  { repository: "github.com/evil/path" },
  { repository: "https://evil.test" },
  { number: 0 },
  { head_sha: "HEAD" },
  { base_sha: "abc123" },
  { fetched_at: "yesterday" },
  { checks: "looks good" },
  { local: { path: "/repo", common_directory: "/repo/../private" } },
])("rejects malformed or ambiguous PR metadata %j", (patch) => {
  expect(() => validateArtifactGitHubPR({ ...pr, ...patch })).toThrow();
});
