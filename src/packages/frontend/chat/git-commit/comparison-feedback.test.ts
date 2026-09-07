import { comparisonFeedbackPrompt } from "./comparison-feedback";

test("feedback includes exact comparison provenance and only draft comments", () => {
  const target = {
    kind: "comparison" as const,
    repository: {
      projectId: "p",
      commonDirectory: "/r/.git",
      locator: "/r",
      objectFormat: "sha1" as const,
    },
    mode: "merge-base" as const,
    base: "a".repeat(40),
    head: "b".repeat(40),
    requestedBase: "c".repeat(40),
  };
  const comment = {
    id: "one",
    file_path: " a.ts ",
    side: "old" as const,
    line: 20,
    body_md: "change this",
    status: "draft" as const,
    created_at: 1,
    updated_at: 1,
    local_revision: 1,
  };
  const prompt = comparisonFeedbackPrompt(target, {
    reviewed: false,
    note: "note",
    comments: {
      one: comment,
      two: {
        ...comment,
        id: "two",
        status: "resolved",
        body_md: "already resolved",
      },
    },
  });
  expect(prompt).toContain(JSON.stringify(target, null, 2));
  expect(prompt).toContain('"file_path": " a.ts "');
  expect(prompt).toContain('"side": "old"');
  expect(prompt).not.toContain("already resolved");
});
